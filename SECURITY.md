# Security Policy

## Secrets and page content

Provider keys are stored in browser extension-local storage and are only read by the background context. They are not exposed to page scripts or returned to content scripts. Extension storage is not an encrypted secret manager, so users should create restricted keys with conservative spending limits.

The extension sends non-editable website text to the provider selected in Settings. Form values, editable text, scripts, and styles are excluded. Same-origin frames may inherit the top-level website rule, but a cross-origin frame must have its own explicit Always rule. Provider endpoints and the `authenticationInfo` and `websiteContent` disclosures must remain explicit in privacy documentation, Firefox consent metadata, and store listings.

Never commit real API keys, browser profiles, generated builds, or captured page content. Report suspected credential exposure or unintended content transmission privately to the repository owner before opening a public issue.

Use GitHub's private vulnerability reporting feature from the repository **Security** tab when it is available. Do not include API keys, captured private pages, or other users' data in a public issue. Maintainers should revoke exposed credentials immediately and publish a security advisory when users need to take action.
