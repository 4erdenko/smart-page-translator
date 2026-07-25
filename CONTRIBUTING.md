# Contributing

## Development workflow

1. Install Node.js 24 or a compatible release from `package.json` and run `npm ci`.
2. Make focused changes in `src/`, `manifests/`, `scripts/`, or `test/`.
3. Run `npm run check` before opening a pull request.
4. Load the relevant `dist/` target and manually verify browser behavior for DOM, popup, settings, or animation changes.

Do not edit `dist/` or `artifacts/`; both are generated and ignored. Keep provider-independent behavior in shared libraries. A provider adapter must define its endpoint-specific request fields, model filtering, and tests without leaking credentials to content scripts.

Keep UI strings in `src/_locales/*/messages.json` and use `src/lib/ui-i18n.js` from popup and options code. Every shipped locale must contain the same message keys. Use `Intl.DisplayNames` through the shared helper instead of duplicating translated language names.

Use short Conventional Commit messages such as `feat: add provider model discovery`. Pull requests should describe user-visible behavior, compatibility, privacy or quota impact, and the exact validation performed. Include screenshots or a short recording for UI changes.

API keys must be entered through the extension Settings UI. Never add build-time keys, fixtures containing live secrets, or environment-based credential loading.

Use reserved example domains and fictional names in tests, screenshots, and documentation. Never commit captured storefront data, personal profiles, local filesystem paths, browser state, or provider responses from a real account.

The npm override for `minimatch` keeps Mozilla's `addons-linter` on the patched `brace-expansion` dependency line. Keep it until `addons-linter` ships a non-vulnerable dependency tree; validate any removal with both `npm audit` and `npm run lint:firefox`.

## Licensing

By contributing, you agree that your contribution is provided under the Mozilla Public License 2.0.
