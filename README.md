# Smart Page Translator

Cross-browser Manifest V3 WebExtension for complete, cached website translation. One source tree produces reviewable Firefox and Chrome builds without remote executable code.

## Features

- Translates text nodes, product names, placeholders, image labels, tooltips, accessibility labels, options, and dynamically inserted DOM content.
- Preserves detected brands, trademarks, model identifiers, and proper names while translating descriptive product text.
- Supports DeepSeek and OpenAI. API keys are entered in Settings and stored in local extension storage; `.env` files and build-time keys are not used.
- Loads the models available to the configured provider account from its `/models` endpoint and filters out audio, image, embedding, moderation, realtime, and other incompatible models.
- Applies automatic language rules and per-origin `Always`, `Automatic`, or `Never` policies, including SPA route changes.
- Translates same-origin frames with the parent website while requiring an explicit `Always` rule for cross-origin frames.
- Reuses translations from a persistent, LRU-style local cache.
- Keeps private/incognito page text out of persistent storage and offers one-time translation for those tabs.

## Install for development

```bash
npm ci
npm run check
```

Firefox:

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

Chrome:

1. Run `npm run build:chrome`.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `dist/chrome/`.

Open the extension Settings, select DeepSeek or OpenAI, enter that provider's key, load its model list, and save a model. Temporary Firefox add-ons are removed when Firefox exits; a signed installation is required for dependable persistence across full browser restarts.

## Development commands

- `npm test` — run unit and race-condition tests.
- `npm run lint` — lint source, scripts, and tests with ESLint.
- `npm run build` — create both `dist/firefox/` and `dist/chrome/`.
- `npm run check` — run the complete CI-equivalent validation, including Mozilla's add-on linter.
- `npm run package:firefox` / `npm run package:chrome` — create reproducible ZIP files in `artifacts/`.

The shared manifest lives in `manifests/base.json`; browser-specific background declarations live in `manifests/firefox.json` and `manifests/chrome.json`. Firefox uses background scripts, while Chrome uses `src/service-worker.js`. Mozilla's `webextension-polyfill` keeps the Promise-based `browser.*` API consistent.

`src/assets/icon.svg` is the editable icon source. Manifest and toolbar icons use committed PNG variants from 16 to 128 pixels because Chrome does not support SVG extension icons.

## Permissions

- `activeTab` lets the popup identify and message the page on which the user opened it.
- `storage` stores provider keys, settings, website rules, and cached translations locally.
- `unlimitedStorage` prevents the bounded 16 MiB cache from colliding with Chrome's smaller default local-storage quota.
- The content script matches all websites because translating arbitrary pages is the extension's single purpose.
- Host permissions are limited to `api.deepseek.com` and `api.openai.com`, the two selectable translation providers.

The extension does not request browsing history, cookies, downloads, clipboard, web request, or native messaging access.

## Cache and performance

The default cache holds 8,000 phrases, roughly 64,000 source words at eight words per phrase. The safe configurable maximum is 20,000 phrases, or roughly 160,000 source words, but the independent 16 MiB serialized-size limit is authoritative. The `unlimitedStorage` permission prevents the cache from colliding with Chrome's normal 10 MiB `storage.local` quota; the extension still enforces its own tighter limit.

DOM references are weak, scan and cleanup work is time-sliced, request queues are bounded, and at most 12 text-bound magic rectangles can exist globally. A real cache miss starts the shimmer before the provider request and keeps it perceptible even for a fast response. Translation motion uses compositor-friendly transforms and opacity, so it follows the display refresh rate, including 120 Hz displays, without a JavaScript frame loop. Cache writes are serialized and completed before a Manifest V3 background worker may suspend. Chrome storage access is restricted to trusted extension contexts. Firefox does not expose the equivalent access-level control, so bundled content scripts never read provider credentials and receive only sanitized settings through validated extension messages.

Background validation limits each translation batch to 48 items and 10,000 input characters. The extension does not impose a per-minute request or character quota by default; provider account limits remain authoritative. Concurrency, queue length, network retries, and recursive response splitting stay bounded to prevent runaway work and memory growth without stopping an ordinary large page.

Cache phrases are stored as independent extension-storage entries. A completed translation batch writes only its changed phrases instead of serializing the entire cache; existing monolithic `translationCacheV1` data is migrated automatically on first use.

## Privacy and provider APIs

When translation is active, non-editable page text is sent directly to the selected provider. User-entered form values are not sent. Keys are never returned to content scripts or displayed after saving, but browser extension storage is not a hardware-backed secret vault; use restricted, low-limit provider keys. Private/incognito translations bypass the persistent cache, and website rules cannot be saved from a private tab.

See [PRIVACY.md](PRIVACY.md) for the complete data-flow summary and [SECURITY.md](SECURITY.md) for secret-handling guidance.

Before publishing a release, follow [docs/STORE_SUBMISSION.md](docs/STORE_SUBMISSION.md). Shipped third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Implementation references: [Firefox WebExtensions compatibility](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities), [Firefox add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/), [Chrome extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics), [Chrome Web Store policies](https://developer.chrome.com/docs/webstore/program-policies/policies), [DeepSeek models API](https://api-docs.deepseek.com/api/list-models), and [OpenAI models](https://developers.openai.com/api/docs/models).
