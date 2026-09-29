import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  readCherryProvider,
  synchronizeCherryProvider,
  type BridgeOptions,
  type BridgeServices,
  type SettingsPathOp,
} from '../src/bridge.ts'

interface FixtureOptions {
  providerName?: string
  baseUrl?: string
  providerEnabled?: boolean
  keyEnabled?: boolean
  modelId?: string
}

function createReasoningRegistry(modelId: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cherry-provider-registry-'))
  const path = join(directory, 'models.json')
  writeFileSync(path, JSON.stringify({
    models: [{
      id: modelId,
      ownedBy: 'deepseek',
      reasoning: {
        supportedEfforts: ['none', 'high', 'max', 'xhigh'],
      },
    }],
    version: 'test',
  }))
  return path
}

function createFixture(options: FixtureOptions = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cherry-provider-bridge-'))
  const databasePath = join(directory, 'cherrystudio.sqlite')
  const providerName = options.providerName ?? `Musk-${randomUUID()}`
  const modelId = options.modelId ?? `deepseek-${randomUUID()}`
  const providerId = randomUUID()
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      CREATE TABLE user_provider (
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        endpoint_configs TEXT NOT NULL,
        default_chat_endpoint TEXT NOT NULL,
        api_keys TEXT NOT NULL,
        is_enabled INTEGER NOT NULL
      );
      CREATE TABLE user_model (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT,
        context_window INTEGER,
        max_output_tokens INTEGER,
        input_modalities TEXT,
        endpoint_types TEXT,
        reasoning TEXT,
        is_enabled INTEGER NOT NULL,
        is_hidden INTEGER NOT NULL,
        is_deprecated INTEGER NOT NULL,
        order_key TEXT
      );
    `)
    database.prepare(`
      INSERT INTO user_provider
        (provider_id, name, endpoint_configs, default_chat_endpoint, api_keys, is_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      providerId,
      providerName,
      JSON.stringify({
        'openai-chat-completions': { baseUrl: options.baseUrl ?? 'https://api.example.test' },
      }),
      'openai-chat-completions',
      JSON.stringify([{ id: randomUUID(), key: `sk-${randomUUID()}`, isEnabled: options.keyEnabled ?? true }]),
      options.providerEnabled === false ? 0 : 1,
    )
    database.prepare(`
      INSERT INTO user_model
        (provider_id, model_id, name, context_window, max_output_tokens, input_modalities,
         endpoint_types, reasoning, is_enabled, is_hidden, is_deprecated, order_key)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, 0, 0, ?)
    `).run(providerId, modelId, '深度思考模型', 262_144, 32_768, JSON.stringify(['text']), 'a')
  } finally {
    database.close()
  }
  return databasePath
}

function bridgeOptions(
  databasePath: string,
  providerName: string,
  modelId: string,
  modelRegistryPath?: string,
): BridgeOptions {
  return {
    databasePath,
    providerName,
    routeId: 'muskapi',
    credentialRef: 'MUSKAPI_API_KEY',
    modelIds: [modelId],
    ...(modelRegistryPath === undefined ? {} : { modelRegistryPath }),
  }
}

test('It reads an enabled Cherry provider without endpoint discovery', () => {
  const providerName = `火星-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })

  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, modelId))

  assert.equal(snapshot.displayName, providerName, 'The provider display name was not preserved')
  assert.equal(snapshot.api, 'openai-completions', 'The Cherry endpoint was not mapped to the DSH protocol')
  assert.equal(snapshot.baseURL, 'https://api.example.test/v1', 'The OpenAI API version path was not added')
  assert.deepEqual(
    snapshot.models,
    [{ id: modelId, name: '深度思考模型', contextWindow: 262_144, maxTokens: 32_768, input: ['text'] }],
    'The selected Cherry model metadata was not preserved',
  )
  assert.match(snapshot.apiKey, /^sk-/, 'The enabled Cherry credential was not selected')
})

test('It does not duplicate an existing OpenAI version path', () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId, baseUrl: 'https://api.example.test/gateway/v1/' })

  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, modelId))

  assert.equal(snapshot.baseURL, 'https://api.example.test/gateway/v1', 'The existing version path was duplicated')
})

test('It exposes Cherry reasoning efforts for a hand-declared DeepSeek model', () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = 'deepseek-v4-pro'
  const databasePath = createFixture({ providerName, modelId })
  const modelRegistryPath = createReasoningRegistry(modelId)

  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, modelId, modelRegistryPath))

  assert.deepEqual(
    snapshot.models[0].reasoningEfforts,
    { off: null, high: 'high', max: 'max', xhigh: 'xhigh' },
    'The hand-declared model did not receive its selectable thinking efforts',
  )
  assert.deepEqual(
    snapshot.models[0].compat,
    { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    'The DeepSeek thinking wire compatibility was not declared',
  )
})

test('It reads every enabled Cherry model when no whitelist is configured', () => {
  const providerName = `Musk-${randomUUID()}`
  const firstModelId = `deepseek-${randomUUID()}`
  const secondModelId = `glm-${randomUUID()}`
  const disabledModelId = `disabled-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId: firstModelId })
  const database = new DatabaseSync(databasePath)
  try {
    const provider = database.prepare('SELECT provider_id FROM user_provider WHERE name = ?').get(providerName) as {
      provider_id: string
    }
    const insert = database.prepare(`
      INSERT INTO user_model
        (provider_id, model_id, name, context_window, max_output_tokens, input_modalities,
         endpoint_types, reasoning, is_enabled, is_hidden, is_deprecated, order_key)
      VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, ?)
    `)
    insert.run(provider.provider_id, secondModelId, '通用模型', 1, 'b')
    insert.run(provider.provider_id, disabledModelId, '禁用模型', 0, 'c')
  } finally {
    database.close()
  }

  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, firstModelId))
  const allModels = readCherryProvider({
    ...bridgeOptions(databasePath, providerName, firstModelId),
    modelIds: [],
  })

  assert.deepEqual(
    allModels.models.map(model => model.id),
    [snapshot.models[0].id, secondModelId],
    'The unfiltered bridge did not include every enabled Cherry model',
  )
})

test('It excludes models restricted to another Cherry endpoint', () => {
  const providerName = `Musk-${randomUUID()}`
  const chatModelId = `deepseek-${randomUUID()}`
  const anthropicModelId = `claude-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId: chatModelId })
  const database = new DatabaseSync(databasePath)
  try {
    const provider = database.prepare('SELECT provider_id FROM user_provider WHERE name = ?').get(providerName) as {
      provider_id: string
    }
    database.prepare(`
      INSERT INTO user_model
        (provider_id, model_id, name, context_window, max_output_tokens, input_modalities,
         endpoint_types, reasoning, is_enabled, is_hidden, is_deprecated, order_key)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, 1, 0, 0, ?)
    `).run(
      provider.provider_id,
      anthropicModelId,
      'Claude 限定模型',
      JSON.stringify(['anthropic-messages']),
      'b',
    )
  } finally {
    database.close()
  }

  const snapshot = readCherryProvider({
    ...bridgeOptions(databasePath, providerName, chatModelId),
    modelIds: [],
  })

  assert.deepEqual(
    snapshot.models.map(model => model.id),
    [chatModelId],
    'A model restricted to another endpoint entered the OpenAI route',
  )
})

test('It rejects a missing Cherry provider', () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })

  assert.throws(
    () => readCherryProvider(bridgeOptions(databasePath, `missing-${randomUUID()}`, modelId)),
    'A missing provider was accepted',
  )
})

test('It rejects a provider without an enabled credential', () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId, keyEnabled: false })

  assert.throws(
    () => readCherryProvider(bridgeOptions(databasePath, providerName, modelId)),
    'A provider without an enabled credential was accepted',
  )
})

test('It surfaces a locked Cherry database for the retry loop', () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })
  const writer = new DatabaseSync(databasePath)
  try {
    writer.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;')
    assert.throws(
      () => readCherryProvider(bridgeOptions(databasePath, providerName, modelId)),
      'A locked database read did not fail for a later retry',
    )
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
})

test('It writes the credential and a manual DSH model route', async () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })
  let storedCredential: string | undefined
  let mutations: SettingsPathOp[] = []
  const services: BridgeServices = {
    resolveCredential: async () => storedCredential,
    setCredential: async (_ref, value) => { storedCredential = value },
    getPiAiSettings: () => ({ value: { providers: {} }, revision: 0 }),
    mutatePiAiSettings: async ops => { mutations = [...ops] },
  }

  const result = await synchronizeCherryProvider(
    bridgeOptions(databasePath, providerName, modelId),
    services,
  )

  assert.equal(result.credentialChanged, true, 'The missing DSH credential was not written')
  assert.equal(result.settingsChanged, true, 'The missing DSH route was not written')
  assert.equal(result.settingsPending, false, 'A registered settings namespace was treated as pending')
  assert.match(storedCredential ?? '', /^sk-/, 'The stored DSH credential did not match the Cherry credential')
  assert.deepEqual(
    mutations.find(op => op.path.at(-1) === 'api'),
    { op: 'set', path: ['providers', 'muskapi', 'api'], value: 'openai-completions' },
    'The route still depended on provider discovery',
  )
  assert.deepEqual(
    mutations.find(op => op.path.at(-1) === 'models')?.value,
    [{ id: modelId, name: '深度思考模型', contextWindow: 262_144, maxTokens: 32_768, input: ['text'] }],
    'The manual model list was not written',
  )
})

test('It skips writes when Cherry and DSH are already synchronized', async () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId, baseUrl: 'https://api.example.test/v1' })
  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, modelId))
  let credentialWrites = 0
  let settingsWrites = 0
  const services: BridgeServices = {
    resolveCredential: async () => snapshot.apiKey,
    setCredential: async () => { credentialWrites += 1 },
    getPiAiSettings: () => ({
      value: {
        providers: {
          muskapi: {
            displayName: snapshot.displayName,
            apiKeyEnv: 'MUSKAPI_API_KEY',
            api: snapshot.api,
            baseURL: snapshot.baseURL,
            models: snapshot.models,
          },
        },
      },
      revision: 0,
    }),
    mutatePiAiSettings: async () => { settingsWrites += 1 },
  }

  const result = await synchronizeCherryProvider(
    bridgeOptions(databasePath, providerName, modelId),
    services,
  )

  assert.deepEqual(
    result,
    { credentialChanged: false, settingsChanged: false, settingsPending: false },
    'An unchanged bridge was reported as modified',
  )
  assert.equal(credentialWrites, 0, 'An unchanged credential was rewritten')
  assert.equal(settingsWrites, 0, 'An unchanged provider route was rewritten')
})

test('It writes the pi-ai profile entry with its revision and preserves other route fields', async t => {
  const { apply, Config } = await import('../lib/index.js')
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })
  const snapshot = readCherryProvider(bridgeOptions(databasePath, providerName, modelId))
  const providers: Record<string, Record<string, unknown>> = {
    other: { api: 'openai-responses' },
    cherry: { timeoutMs: 12345 },
  }
  let revision = 7
  let settingsWrites = 0
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers }, revision }],
    async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision: number) {
      assert.equal(ns, 'llm-pi-ai', 'The wrong profile entry was selected')
      assert.equal(expectedRevision, revision, 'The profile revision was not forwarded')
      for (const op of ops) {
        assert.deepEqual(op.path.slice(0, 2), ['providers', 'cherry'])
        providers.cherry[op.path[2]] = op.value
      }
      revision += 1
      settingsWrites += 1
    },
  }
  let storedCredential: string | undefined
  let credentialWrites = 0
  const warnings: unknown[][] = []
  const ctx = {
    settings,
    credentials: {
      resolve: async (ref: string) => {
        assert.equal(ref, 'CHERRY_API_KEY')
        return storedCredential === undefined ? undefined : { value: storedCredential }
      },
      set: async (ref: string, value: string) => {
        assert.equal(ref, 'CHERRY_API_KEY')
        storedCredential = value
        credentialWrites += 1
      },
    },
    logger: { info() {}, debug() {}, warn: (...args: unknown[]) => warnings.push(args) },
    effect: (setup: () => () => void) => { t.after(setup()) },
  } as unknown as Context
  const config = Config({ providerName, databasePath, modelIds: [modelId], routeId: 'cherry', credentialRef: 'CHERRY_API_KEY' })

  await apply(ctx, config)
  assert.deepEqual(providers.cherry, {
    timeoutMs: 12345,
    displayName: snapshot.displayName,
    apiKeyEnv: 'CHERRY_API_KEY',
    api: snapshot.api,
    baseURL: snapshot.baseURL,
    models: snapshot.models,
  })
  assert.deepEqual(providers.other, { api: 'openai-responses' })
  assert.equal(storedCredential, snapshot.apiKey)
  assert.equal(JSON.stringify(providers).includes(snapshot.apiKey), false)
  await apply(ctx, config)
  assert.equal(settingsWrites, 1, 'The resolved namespace should not be rewritten on the next sync')
  assert.equal(credentialWrites, 1)
  assert.deepEqual(warnings, [])
})

test('It retries the Profile entry after the llm-pi-ai plugin becomes available', async () => {
  const providerName = `Musk-${randomUUID()}`
  const modelId = `deepseek-${randomUUID()}`
  const databasePath = createFixture({ providerName, modelId })
  let ready = false
  let storedCredential: string | undefined
  let settingsWrites = 0
  const services: BridgeServices = {
    resolveCredential: async () => storedCredential,
    setCredential: async (_ref, value) => { storedCredential = value },
    getPiAiSettings: () => ready ? { value: { providers: {} }, revision: 0 } : undefined,
    mutatePiAiSettings: async () => { settingsWrites += 1 },
  }
  const options = bridgeOptions(databasePath, providerName, modelId)
  assert.deepEqual(await synchronizeCherryProvider(options, services), {
    credentialChanged: true, settingsChanged: false, settingsPending: true,
  })
  assert.equal(settingsWrites, 0)
  ready = true
  assert.deepEqual(await synchronizeCherryProvider(options, services), {
    credentialChanged: false, settingsChanged: true, settingsPending: false,
  })
  assert.equal(settingsWrites, 1)
})
