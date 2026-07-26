# Private Reviewer Notes

## Version and build

Version: 0.2.1

Source revision: tag `v0.2.1`

Build on Ubuntu 24.04 ARM64 or macOS with Node.js 24 and npm 11:

```bash
npm ci
npm run build:firefox
```

The unpacked output is `dist/firefox/`. `npm run package:firefox` creates the submitted Firefox archive. The build is deterministic; `npm run package:stores` also writes `artifacts/SHA256SUMS`.

## Provider setup

Translation requires a DeepSeek or OpenAI API key. Provide a temporary spend-limited reviewer key only in the store's private credential field, never in source code or public listing text. The first-run page links to the provider's official key page, verifies the key before saving it, and selects a compatible model.

## Functional test

1. Install the extension and complete the focused first-run setup.
2. Open a public text page, use the toolbar popup, and select Translate once.
3. Confirm the page can switch among Original, Translation, and Bilingual without another provider request.
4. Add an Always or Never website rule and reload the page.
5. Select text and use the small Translate action or context menu.
6. Focus a form field and use Translate this field; the result is not cached.
7. Open the PDF workspace, choose a small text-based PDF, press Translate document, and download the translated copy.
8. Open Settings to clear the cache and inspect provider, language, site, protected-term, animation, and cache controls.

Automatic translation excludes form values and editable text. Cross-origin frames require their own explicit Always rule. Private-window translations bypass persistent cache storage and cannot save per-site rules.

## PDF implementation

PDF bytes, filenames, images, layout coordinates, and annotations stay local. Only grouped extracted text and short neighboring-text context are transmitted after Translate document is pressed. PDF export is created locally and flattens the page; links, annotations, interactive forms, and digital signatures are not retained.

PDF.js and PDF-LIB are pinned upstream release assets. The official fontkit browser module is bundled with esbuild and a small first-party PDF-LIB compatibility adapter; third-party code is neither patched nor post-processed. The locked runtime dependency graph is verified during the build, generated dynamic code is rejected, and DejaVu Sans Regular and Bold are copied from a locked package with their license for searchable PDF export. Mozilla's linter reports four allowlisted upstream PDF.js warnings in two files; project runtime source is separately tested to reject dynamic imports.

## Network and privacy

The extension connects only to `api.deepseek.com` or `api.openai.com`, selected by the user. It includes no analytics, advertising, telemetry, remote executable code, maintainer proxy, or shared API key. Full data flow and Limited Use disclosure: `PRIVACY.md`.
