# Repository Guidelines

## Project Structure & Module Organization

Runtime code lives in `src/`. `background.js` owns provider requests, credentials, settings, and cache persistence; `content.js` scans and updates page DOM. Pure provider, translation, and DOM helpers belong in `src/lib/`. Popup and settings UI live under `src/popup/` and `src/options/`.

Shared and browser-specific manifests live in `manifests/`. `scripts/build.mjs` produces `dist/firefox/` and `dist/chrome/`; never edit generated output. Tests live in `test/`. CI configuration is under `.github/`.

## Build, Test, and Development Commands

- `npm test` runs all `node:test` suites.
- `npm run lint` checks JavaScript with ESLint.
- `npm run build` creates both browser targets.
- `npm run check` runs lint, tests, manifest validation, both builds, and Mozilla add-on validation.
- `npm run package:firefox` or `npm run package:chrome` writes a browser ZIP to `artifacts/`.
- `npm run package:source` writes a deterministic public-source ZIP for Mozilla review.

Load `dist/firefox/manifest.json` from `about:debugging`, or load `dist/chrome/` unpacked from `chrome://extensions`.

## Coding Style & Naming Conventions

Use vanilla JavaScript, two-space indentation, double quotes, and semicolons. Use `camelCase` for variables and functions, `PascalCase` for constructors, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames. Keep code, identifiers, and comments in English. Place comments on the line before the code they explain.

Keep browser APIs Promise-based through `webextension-polyfill`. Put shared logic in testable library modules and keep provider-specific request fields out of DOM code.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; name files `*.test.js`. Cover cache concurrency, provider request shapes, dynamic model filtering, language policies, brand protection, and parsing failures. DOM, SPA, or animation changes also require manual Firefox validation on a dynamic storefront.

## Commits, Pull Requests, and Security

Use focused Conventional Commits, for example `fix: serialize cache clearing`. Pull requests should explain behavior, privacy and performance impact, validation, and include screenshots for UI changes.

Never commit API keys, `.env`, `dist/`, `artifacts/`, or browser profiles. Keys must enter through Settings and remain in extension-local storage.
