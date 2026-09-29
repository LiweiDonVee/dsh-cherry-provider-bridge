# DSH Cherry Provider Bridge

Reuse a selected Cherry Studio provider in DeepSeek Harness, including its enabled model catalog, without relying on provider `GET /models` discovery.

Built to interoperate with [Cherry Studio by CherryHQ](https://github.com/CherryHQ/cherry-studio): Cherry owns the source provider/model configuration this bridge consumes. This is an independent community adapter, **not an official Cherry Studio plugin or a fork of Cherry Studio**. See [relationship, provenance and license boundaries](NOTICE.md).

The bridge reads Cherry's SQLite database read-only and periodically synchronizes the credential and manual model route through DSH services. It adds a missing OpenAI `/v1` suffix once and preserves model metadata and compatible reasoning options.

## Requirements

- Node.js 24 and npm.
- DSH **0.1.7-rc.2**, with its credential/settings providers and `llm-pi-ai` Profile entry.
- Cherry Studio database tables `user_provider` and `user_model` matching the tested schema. Cherry's database is an internal interface; arbitrary versions are not guaranteed.
- Windows paths are discovered automatically. On other systems provide `databasePath` and, if needed, `modelRegistryPath` explicitly.

## Install and configure

```sh
git clone https://github.com/LiweiDonVee/dsh-cherry-provider-bridge.git
cd dsh-cherry-provider-bridge
npm ci
npm run check
```

Edit `cordis.patch.yml` before enabling: set `providerName` to the exact enabled provider name in Cherry. Choose a new `routeId` and `credentialRef` if you do not want to overwrite an existing DSH route/credential.

```yaml
providerName: My Provider
routeId: cherry
credentialRef: CHERRY_API_KEY
modelIds: []
databasePath: ''
modelRegistryPath: ''
syncIntervalMs: 5000
```

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile web add .
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 web
```

Restart an already running host. Keep the clone if installed as a local link.
Select the synchronized provider/model in DSH. Empty `modelIds` includes all enabled, visible, compatible models; a list restricts the selection.

Default database: `%APPDATA%/CherryStudio/Data/cherrystudio.sqlite`.
Default optional registry: `%ProgramFiles%/Cherry Studio/resources/provider-registry/models.json`.

## Data ownership and recovery

This intentionally copies the selected key into DSH's credential store, not Profile configuration. It does not send the database to any service. DSH subsequently uses the configured endpoint for model calls. Synchronization runs every five seconds, skips unchanged values and retries temporary lock/Profile-entry failures.

To stop synchronization, remove the plugin and restart DSH:

```sh
npx --yes @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile web remove dsh-cherry-provider-bridge
```

The synchronized route and credential remain. Remove them through DSH if desired; uninstalling does not revoke a provider key.

## Verification

`npm run check` runs TypeScript checks, builds the distributable, and runs 12 tests using temporary SQLite fixtures plus the DSH Profile settings boundary. No real key or Cherry database is included. Paid-provider requests and every Cherry release are not certified.

Independent community plugin, not affiliated with DeepSeek AI or Cherry Studio. MIT; [LICENSE](LICENSE).
