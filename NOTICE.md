# Relationship to Cherry Studio

This project is an independent interoperability adapter for [Cherry Studio](https://github.com/CherryHQ/cherry-studio) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), maintained by LiweiDonVee.

Cherry Studio is the source application and the owner of the provider/model data structures consumed by this bridge. The bridge reads an installed Cherry database in read-only mode, translates a selected custom provider/model catalog into DSH configuration, and writes via DSH credential/settings services. This is the technical relationship acknowledged by “Cherry” in the name.

It is **not** a Cherry Studio fork, an official Cherry Studio extension, or a project sponsored, endorsed or maintained by CherryHQ or DeepSeek AI. Names identify interoperability targets; no logos or bundled Cherry catalogs are included.

## Reference points

Reviewed on 2026-09-07 against Cherry Studio source commit `e131f495a9af593ec873bea34b935e97d644f586`:

- [Provider/model registry overview](https://github.com/CherryHQ/cherry-studio/blob/e131f495a9af593ec873bea34b935e97d644f586/docs/references/provider-model/provider-registry.md)
- [user_provider schema](https://github.com/CherryHQ/cherry-studio/blob/e131f495a9af593ec873bea34b935e97d644f586/src/main/data/db/schemas/userProvider.ts)
- [user_model schema](https://github.com/CherryHQ/cherry-studio/blob/e131f495a9af593ec873bea34b935e97d644f586/src/main/data/db/schemas/userModel.ts)
- [Cherry Studio's own license](https://github.com/CherryHQ/cherry-studio/blob/e131f495a9af593ec873bea34b935e97d644f586/LICENSE)

These are provenance and interface references, not a claim of complete compatibility with that commit or every Cherry release. Cherry's internal schema and registry merge behavior can change. The bridge covers the custom-provider shape asserted in its tests; it is not a full reimplementation of Cherry's preset inheritance/registry resolution.

## Licensing boundary

Cherry Studio is separately licensed under AGPL-3.0 as identified by its repository. The bridge's MIT license applies to this repository's own implementation. This release does not vendor Cherry application code, logos or registry datasets; its tests build synthetic SQLite rows. Referencing an interface does not relicense the upstream application or data. Any future copied upstream code or redistributed catalogs require a separate license review and preserved notices.

Thanks to the Cherry Studio contributors for the application and provider/model ecosystem that make this integration useful.
