# English Store Listing

## Product details

**Name:** Smart Page Translator

**Summary:** Translate complete web pages and PDFs with DeepSeek or OpenAI, bilingual views, and a persistent local cache.

**Category:** Productivity

**Search terms:** page translation, bilingual reading, PDF translation, DeepSeek, OpenAI

## Description

Smart Page Translator translates complete web pages, dynamic interfaces, selected text, editable fields, and text-based PDFs with the AI provider you choose.

It began as a personal tool for pages where ordinary translators left buttons, product descriptions, accessibility labels, or newly loaded content untranslated. It was then rebuilt as a reviewable open-source extension for public use: no ads, no analytics, no telemetry, and no extension subscription.

Choose DeepSeek or OpenAI, bring your own API key, and select any compatible text model available to your provider account. Provider usage may be billed by that provider; the extension does not sell translation or operate a proxy.

Key features:

- Whole-page translation that follows dynamic content and single-page navigation.
- Original, translated, and compact bilingual reading views.
- Global language rules plus per-site translation and view preferences.
- Product-description translation with conservative brand and proper-name protection.
- Explicit translation for selected text and focused editable fields.
- Local PDF parsing, side-by-side preview, and translated PDF download.
- A persistent, bounded local cache that avoids repeating identical requests.
- English and Russian extension interfaces.

Privacy is part of the design. API keys and cached translations stay in extension-local storage. Page text goes directly to the selected provider only when translation runs. Editable fields, selections, and PDF text are sent only after an explicit action. Private-window translations are not added to the persistent cache.

The source code, data flow, build instructions, and third-party notices are public.

## Version 0.2.0 notes

First public release with whole-page and PDF translation, original/translated/bilingual views, DeepSeek and OpenAI setup, per-site rules, protected terms, and the bounded local cache.

## Public links

- Homepage and support: `https://github.com/4erdenko/smart-page-translator`
- Issues: `https://github.com/4erdenko/smart-page-translator/issues`
- Privacy policy: `https://github.com/4erdenko/smart-page-translator/blob/main/PRIVACY.md`
- Source for version 0.2.0: `https://github.com/4erdenko/smart-page-translator/tree/v0.2.0`
