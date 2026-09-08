import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  synchronizeCherryProvider,
  type BridgeOptions,
  type BridgeServices,
  type BridgeSyncResult,
} from './bridge.js'

export const name = 'dsh-cherry-provider-bridge'
export const inject = ['credentials', 'settings']

/** User configuration for the Cherry custom-provider bridge. */
export interface Config {
  providerName: string
  routeId: string
  credentialRef: string
  modelIds: string[]
  databasePath: string
  modelRegistryPath: string
  syncIntervalMs: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('My Provider'),
  routeId: z.string().default('cherry'),
  credentialRef: z.string().default('CHERRY_API_KEY'),
  modelIds: z.array(z.string()).default([]),
  databasePath: z.string().default(''),
  modelRegistryPath: z.string().default(''),
  syncIntervalMs: z.number().step(1).min(1_000).default(5_000),
})

function defaultDatabasePath(): string {
  const appData = process.env.APPDATA?.trim()
  const roaming = appData !== undefined && appData.length > 0
    ? appData
    : join(homedir(), 'AppData', 'Roaming')
  return join(roaming, 'CherryStudio', 'Data', 'cherrystudio.sqlite')
}

function resolveOptions(config: Config): BridgeOptions {
  const modelIds = [...new Set(config.modelIds.map(value => value.trim()).filter(Boolean))]
  return {
    databasePath: config.databasePath.trim() || defaultDatabasePath(),
    providerName: config.providerName.trim(),
    routeId: config.routeId.trim(),
    credentialRef: config.credentialRef.trim(),
    modelIds,
    ...(config.modelRegistryPath.trim().length === 0 ? {} : { modelRegistryPath: config.modelRegistryPath.trim() }),
  }
}

function resultSummary(result: BridgeSyncResult): string | undefined {
  const changes = [
    result.credentialChanged ? 'credential' : '',
    result.settingsChanged ? 'provider route' : '',
  ].filter(Boolean)
  return changes.length > 0 ? changes.join(' and ') : undefined
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const options = resolveOptions(config)
  const ref = credentialRef(options.credentialRef)
  const namespace = 'llm-pi-ai'
  const services: BridgeServices = {
    resolveCredential: async () => (await ctx.credentials.resolve(ref))?.value,
    setCredential: async (_credential, value) => ctx.credentials.set(ref, value),
    getPiAiSettings: () => ctx.settings.get(namespace),
    mutatePiAiSettings: async operations => ctx.settings.mutate(
      namespace,
      operations,
    ),
  }
  let stopped = false
  let running = false
  let lastError = ''
  let pendingReported = false

  const synchronize = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const result = await synchronizeCherryProvider(options, services)
      const changed = resultSummary(result)
      if (changed !== undefined) ctx.logger.info('Cherry provider bridge synchronized %s', changed)
      if (result.settingsPending && !pendingReported) {
        ctx.logger.debug('Cherry provider bridge is waiting for the llm-pi-ai settings namespace')
        pendingReported = true
      }
      if (!result.settingsPending) pendingReported = false
      lastError = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) {
        ctx.logger.warn('Cherry provider bridge synchronization failed: %s', message)
        lastError = message
      }
    } finally {
      running = false
    }
  }

  await synchronize()
  ctx.effect(() => {
    const timer = setInterval(() => { void synchronize() }, config.syncIntervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'cherry-provider-bridge.sync')
}

export {
  readCherryProvider,
  synchronizeCherryProvider,
  type BridgeOptions,
  type BridgeServices,
  type BridgeSyncResult,
  type CherryProviderSnapshot,
  type DshModelProfile,
  type SettingsPathOp,
} from './bridge.js'
