# Security and privacy

This is an independent community plugin, not an official DeepSeek product.
Tested compatibility is DSH 0.1.2-rc.1. A plugin executes with its host's permissions;
this package is not a sandbox. Only install code you trust.

Do not include real keys, private prompts, session logs or database exports in public issues.
Report sensitive vulnerabilities through GitHub private vulnerability reporting when available.
If it is unavailable, open an issue containing only a request for a private contact.

This bridge intentionally copies the selected provider credential from Cherry Studio into DSH's credential store. It does not encrypt that store or revoke old credentials. Only configure a provider/endpoint you trust; the bridge will replace its configured DSH route. Uninstalling stops synchronization but retains the route and credential.
