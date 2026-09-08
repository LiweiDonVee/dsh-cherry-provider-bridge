import { isDeepStrictEqual } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** Runtime options for one Cherry-to-DSH provider bridge. */
export interface BridgeOptions {
  databasePath: string
  providerName: string
  routeId: string
  credentialRef: string
  modelIds: readonly string[]
  modelRegistryPath?: string
}

/** One model declaration that can be written directly to `llm-pi-ai`. */
export interface DshModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  reasoningEfforts?: Record<string, string | null>
  compat?: {
    thinkingFormat: string
    supportsReasoningEffort: boolean
  }
  [key: string]: unknown
}

/** Sanitized provider metadata plus the credential needed by the credential seam. */
export interface CherryProviderSnapshot {
  displayName: string
  api: string
  baseURL: string
  apiKey: string
  models: DshModelProfile[]
}

/** One settings mutation supported by the DSH settings service. */
export type SettingsPathOp = {
  op: 'set'
  path: readonly string[]
  value: unknown
}

/** DSH service operations needed by the bridge. */
export interface BridgeServices {
  resolveCredential(ref: string): Promise<string | undefined>
  setCredential(ref: string, value: string): Promise<void>
  getPiAiSettings(): unknown | undefined
  mutatePiAiSettings(ops: readonly SettingsPathOp[]): Promise<void>
}

/** Observable outcome of one synchronization attempt. */
export interface BridgeSyncResult {
  credentialChanged: boolean
  settingsChanged: boolean
  settingsPending: boolean
}

interface ProviderRow {
  provider_id: string
  name: string
  endpoint_configs: string
  default_chat_endpoint: string
  api_keys: string
  is_enabled: number
}

interface ModelRow {
  model_id: string
  name: string | null
  context_window: number | null
  max_output_tokens: number | null
  input_modalities: string | null
  endpoint_types: string | null
  reasoning: string | null
  is_enabled: number
  is_hidden: number
  is_deprecated: number
}

interface ModelRegistryEntry {
  id: string
  ownedBy?: string
  reasoning?: {
    supportedEfforts?: string[]
  }
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const ENDPOINT_PROTOCOLS: Readonly<Record<string, string>> = {
  'openai-chat-completions': 'openai-completions',
  'openai-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
}

const PROFILE_FIELDS = ['displayName', 'apiKeyEnv', 'api', 'baseURL', 'models'] as const

function nonEmpty(value: string, label: string): string {
  const resolved = value.trim()
  if (resolved.length === 0) throw new Error(`Cherry provider bridge requires a non-empty ${label}`)
  return resolved
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Cherry provider bridge expected ${label} to be an object`)
  }
  return value as Record<string, unknown>
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`Cherry provider bridge could not parse ${label}`, { cause: error })
  }
}

function defaultModelRegistryPath(): string {
  const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files'
  return join(programFiles, 'Cherry Studio', 'resources', 'provider-registry', 'models.json')
}

function modelRegistry(path: string | undefined): Map<string, ModelRegistryEntry> {
  const registryPath = path?.trim() || defaultModelRegistryPath()
  if (!existsSync(registryPath)) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown
  } catch {
    return new Map()
  }
  const values = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).models
      : undefined
  if (!Array.isArray(values)) return new Map()
  const entries = new Map<string, ModelRegistryEntry>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string') continue
    const reasoning = entry.reasoning
    const normalizedReasoning = typeof reasoning === 'object' && reasoning !== null && !Array.isArray(reasoning)
      ? reasoning as Record<string, unknown>
      : undefined
    const supportedEfforts = normalizedReasoning?.supportedEfforts
    entries.set(entry.id, {
      id: entry.id,
      ...(typeof entry.ownedBy === 'string' ? { ownedBy: entry.ownedBy } : {}),
      ...(Array.isArray(supportedEfforts) && supportedEfforts.every(value => typeof value === 'string')
        ? { reasoning: { supportedEfforts: [...supportedEfforts] } }
        : {}),
    })
  }
  return entries
}

function endpointProtocol(endpoint: string): string {
  const protocol = ENDPOINT_PROTOCOLS[endpoint]
  if (protocol === undefined) {
    throw new Error(`Cherry provider bridge does not support endpoint ${endpoint}`)
  }
  return protocol
}

function normalizedBaseURL(value: string, api: string): string {
  const source = nonEmpty(value, 'base URL')
  let url: URL
  try {
    url = new URL(source)
  } catch (error) {
    throw new Error('Cherry provider bridge received an invalid base URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Cherry provider bridge does not support URL protocol ${url.protocol}`)
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error('Cherry provider bridge base URL cannot contain credentials, a query, or a fragment')
  }
  let path = url.pathname.replace(/\/+$/, '')
  if ((api === 'openai-completions' || api === 'openai-responses') && !/\/v1$/i.test(path)) {
    path = `${path}/v1`
  }
  url.pathname = path.length > 0 ? path : '/'
  return url.toString().replace(/\/$/, '')
}

function enabledApiKey(raw: string, providerName: string): string {
  const entries = parseJson(raw, `API keys for provider ${providerName}`)
  if (!Array.isArray(entries)) {
    throw new Error(`Cherry provider bridge expected API keys for provider ${providerName} to be an array`)
  }
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = entry as Record<string, unknown>
    if (candidate.isEnabled !== true || typeof candidate.key !== 'string') continue
    const key = candidate.key.trim()
    if (key.length > 0) return key
  }
  throw new Error(`Cherry provider ${providerName} has no enabled API key`)
}

function modelProfile(
  row: ModelRow,
  providerName: string,
  registryEntry: ModelRegistryEntry | undefined,
): DshModelProfile {
  if (row.is_enabled !== 1 || row.is_hidden === 1 || row.is_deprecated === 1) {
    throw new Error(`Cherry model ${row.model_id} is not enabled for provider ${providerName}`)
  }
  const profile: DshModelProfile = { id: nonEmpty(row.model_id, 'model ID') }
  const name = row.name?.trim()
  if (name !== undefined && name.length > 0) profile.name = name
  if (row.context_window !== null) profile.contextWindow = row.context_window
  if (row.max_output_tokens !== null) profile.maxTokens = row.max_output_tokens
  if (row.input_modalities !== null) {
    const input = parseJson(row.input_modalities, `input modalities for model ${row.model_id}`)
    if (!Array.isArray(input) || input.some(value => typeof value !== 'string')) {
      throw new Error(`Cherry model ${row.model_id} has invalid input modalities`)
    }
    if (input.length > 0) profile.input = [...input]
  }
  const reasoning = row.reasoning === null
    ? registryEntry?.reasoning?.supportedEfforts
    : parseJson(row.reasoning, `reasoning metadata for model ${row.model_id}`)
  const supportedEfforts = Array.isArray(reasoning)
    ? reasoning.filter(value => typeof value === 'string')
    : typeof reasoning === 'object' && reasoning !== null && !Array.isArray(reasoning)
      ? (() => {
        const values = (reasoning as Record<string, unknown>).selectableEfforts
        return Array.isArray(values) ? values.filter(value => typeof value === 'string') : []
      })()
      : []
  const reasoningEfforts: Record<string, string | null> = {}
  for (const effort of supportedEfforts) {
    const level = effort === 'none' ? 'off' : effort
    if (!THINKING_LEVELS.has(level)) continue
    reasoningEfforts[level] = level === 'off' ? null : level
  }
  if (Object.keys(reasoningEfforts).some(level => level !== 'off')) {
    profile.reasoningEfforts = reasoningEfforts
    if (registryEntry?.ownedBy === 'deepseek') {
      profile.compat = { thinkingFormat: 'deepseek', supportsReasoningEffort: true }
    }
  }
  return profile
}

function supportsEndpoint(row: ModelRow, endpoint: string, providerName: string): boolean {
  if (row.endpoint_types === null) return true
  const endpoints = parseJson(row.endpoint_types, `endpoint types for model ${row.model_id}`)
  if (!Array.isArray(endpoints) || endpoints.some(value => typeof value !== 'string')) {
    throw new Error(`Cherry model ${row.model_id} has invalid endpoint types for provider ${providerName}`)
  }
  return endpoints.length === 0 || endpoints.includes(endpoint)
}

function selectedModels(
  database: DatabaseSync,
  provider: ProviderRow,
  modelIds: readonly string[],
  endpoint: string,
  registry: Map<string, ModelRegistryEntry>,
): DshModelProfile[] {
  const columns = `
    model_id, name, context_window, max_output_tokens, input_modalities, endpoint_types, reasoning,
    is_enabled, is_hidden, is_deprecated
  `
  if (modelIds.length === 0) {
    const rows = database.prepare(`
      SELECT ${columns}
      FROM user_model
      WHERE provider_id = ? AND is_enabled = 1 AND is_hidden = 0 AND is_deprecated = 0
      ORDER BY order_key, rowid
    `).all(provider.provider_id) as unknown as ModelRow[]
    const compatible = rows.filter(row => supportsEndpoint(row, endpoint, provider.name))
    if (compatible.length === 0) {
      throw new Error(`Cherry provider ${provider.name} has no enabled models for endpoint ${endpoint}`)
    }
    return compatible.map(row => modelProfile(row, provider.name, registry.get(row.model_id)))
  }
  const statement = database.prepare(`
    SELECT ${columns}
    FROM user_model
    WHERE provider_id = ? AND model_id = ?
  `)
  return modelIds.map(modelId => {
    const id = nonEmpty(modelId, 'model ID')
    const row = statement.get(provider.provider_id, id) as unknown as ModelRow | undefined
    if (row === undefined) throw new Error(`Cherry provider ${provider.name} does not contain model ${id}`)
    if (!supportsEndpoint(row, endpoint, provider.name)) {
      throw new Error(`Cherry model ${id} does not support endpoint ${endpoint}`)
    }
    return modelProfile(row, provider.name, registry.get(row.model_id))
  })
}

function currentRoute(settings: unknown, routeId: string): Record<string, unknown> | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined
  const providers = (settings as Record<string, unknown>).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return undefined
  const route = (providers as Record<string, unknown>)[routeId]
  if (typeof route !== 'object' || route === null || Array.isArray(route)) return undefined
  return route as Record<string, unknown>
}

function desiredModels(snapshot: CherryProviderSnapshot): DshModelProfile[] {
  return snapshot.models.map(model => ({ ...model }))
}

function settingsOperations(
  snapshot: CherryProviderSnapshot,
  options: BridgeOptions,
  settings: unknown,
): SettingsPathOp[] {
  const route = currentRoute(settings, options.routeId)
  const desired: Record<(typeof PROFILE_FIELDS)[number], unknown> = {
    displayName: snapshot.displayName,
    apiKeyEnv: options.credentialRef,
    api: snapshot.api,
    baseURL: snapshot.baseURL,
    models: desiredModels(snapshot),
  }
  return PROFILE_FIELDS.flatMap(field => (
    isDeepStrictEqual(route?.[field], desired[field])
      ? []
      : [{ op: 'set' as const, path: ['providers', options.routeId, field], value: desired[field] }]
  ))
}

/** Read one enabled Cherry custom provider from its SQLite database. */
export function readCherryProvider(options: BridgeOptions): CherryProviderSnapshot {
  const databasePath = nonEmpty(options.databasePath, 'database path')
  const providerName = nonEmpty(options.providerName, 'provider name')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const rows = database.prepare(`
      SELECT provider_id, name, endpoint_configs, default_chat_endpoint, api_keys, is_enabled
      FROM user_provider
      WHERE name = ?
    `).all(providerName) as unknown as ProviderRow[]
    if (rows.length === 0) throw new Error(`Cherry provider ${providerName} was not found`)
    if (rows.length > 1) throw new Error(`Cherry provider name ${providerName} is ambiguous`)
    const provider = rows[0]
    if (provider.is_enabled !== 1) throw new Error(`Cherry provider ${providerName} is disabled`)
    const endpoint = nonEmpty(provider.default_chat_endpoint, 'default chat endpoint')
    const api = endpointProtocol(endpoint)
    const registry = modelRegistry(options.modelRegistryPath)
    const endpointConfigs = record(parseJson(provider.endpoint_configs, `endpoint config for provider ${providerName}`), 'endpoint config')
    const endpointConfig = record(endpointConfigs[endpoint], `endpoint ${endpoint}`)
    if (typeof endpointConfig.baseUrl !== 'string') {
      throw new Error(`Cherry provider ${providerName} has no base URL for endpoint ${endpoint}`)
    }
    return {
      displayName: nonEmpty(provider.name, 'provider display name'),
      api,
      baseURL: normalizedBaseURL(endpointConfig.baseUrl, api),
      apiKey: enabledApiKey(provider.api_keys, providerName),
      models: selectedModels(database, provider, options.modelIds, endpoint, registry),
    }
  } finally {
    database.close()
  }
}

/** Synchronize one Cherry snapshot into the DSH credential and settings services. */
export async function synchronizeCherryProvider(
  options: BridgeOptions,
  services: BridgeServices,
): Promise<BridgeSyncResult> {
  const snapshot = readCherryProvider(options)
  const existingCredential = await services.resolveCredential(options.credentialRef)
  const credentialChanged = existingCredential !== snapshot.apiKey
  if (credentialChanged) await services.setCredential(options.credentialRef, snapshot.apiKey)
  const settings = services.getPiAiSettings()
  if (settings === undefined) {
    return { credentialChanged, settingsChanged: false, settingsPending: true }
  }
  const operations = settingsOperations(snapshot, options, settings)
  if (operations.length > 0) await services.mutatePiAiSettings(operations)
  return {
    credentialChanged,
    settingsChanged: operations.length > 0,
    settingsPending: false,
  }
}
