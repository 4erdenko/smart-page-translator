# Changelog

All notable changes will be documented in this file.

## Unreleased

- Removed storefront-specific and personal examples from source and tests.
- Limited background network permissions to the supported provider APIs and added an explicit extension-page CSP.
- Prevented private/incognito translations and website choices from entering persistent storage.
- Added neutral public-release guidance and third-party notices.
- Protected brand names only at Unicode word boundaries and accepted numeric-leading or trademark-marked brands.
- Preserved dynamically updated brand labels nested inside branded wrappers, including generic `name` elements.
- Inherited brand classification for names nested inside schema.org Brand and Organization scopes.
- Inherited schema.org Person, Organization, and Place types for nested `itemprop="name"` elements.
- Kept username and account-name field labels eligible for translation without weakening displayed-name protection.
- Kept common profile actions eligible for translation while retaining conservative single-word name protection.
- Removed a duplicate full brand-dictionary pass from every queued text fragment.
- Cancelled obsolete provider requests and released request slots after SPA navigation.
- Inherited same-origin website rules in `about:blank` and `srcdoc` frames while keeping opaque frames disabled.
- Protected brand labels nested inside otherwise unclassified wrapper markup.
- Required an explicit Always rule before translating cross-origin frames.
- Prevented delayed SPA policy work from overriding newly saved website rules.
- Collected brand labels before translation batches so DOM order cannot weaken name protection.
- Discarded stale mutation batches after SPA navigation in favor of the authoritative route rescan.
- Preserved cache entries restored after a preceding storage write fails.
- Separated automatic-language cache entries by the detected page language.
- Detected missing page languages on always-translated websites before caching automatic-source translations.
- Started translation motion only after provider authorization and request-slot acquisition.
- Protected brand terms across capitalization variants while preserving their source spelling.
- Invalidated stale scan queues and translation motion when SPA routes change.
- Refreshed automatic source-language detection on Always-site SPA routes.
- Avoided a duplicate full-page scan when an SPA route enables automatic translation.
- Stopped DOM observation and route polling when settings refresh fails.
- Restarted SPA route monitoring after a manual translation retry.
- Added DeepSeek and OpenAI provider selection with dynamic model discovery.
- Added separate Firefox and Chrome Manifest V3 builds from one source tree.
- Added bounded animation, time-sliced cleanup, SPA language-policy refresh, and serialized cache persistence.
- Added authoritative translation-batch validation and bounded provider retries.
- Changed cache persistence to incremental per-phrase writes with automatic migration from the legacy monolithic cache.
- Fixed Firefox startup when the Chromium-only storage access-level API is unavailable.
- Reworked translation motion into a text-bound, compositor-driven magic effect shown only while a translation request is pending.
- Made translation motion delivery deterministic, perceptible for fast responses, and exclusive to the request that owns a cache miss.
- Removed default per-minute provider request and character quotas.
- Prevented excluded descendant text from being included in translation context.
- Preserved form submission values while translating options without explicit values.
- Rejected empty or disproportionately large provider translations before applying or caching them.
- Enforced the provider input limit after protected-brand masking.
- Avoided ancestor traversal for absent translatable attributes during DOM scans.
- Prevented duplicate API requests while translation-motion delivery is pending.
- Stopped retrying terminal provider errors based on words in their messages.
