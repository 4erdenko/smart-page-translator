# Store Disclosures

## Single purpose

Translate user-requested website and PDF text into a chosen language, while preserving page usability and allowing original, translated, or bilingual reading.

## Permission justifications

- `activeTab`: after the user opens the toolbar popup, identify the active page and send translation or view commands to that tab.
- `contextMenus`: add explicit Translate selection and Translate this field commands.
- `storage`: keep provider settings and credentials, language and site rules, protected terms, and cached translations in extension-local storage.
- `unlimitedStorage`: allow the extension's independently bounded 16 MiB cache to exceed Chromium's smaller default `storage.local` quota without losing settings or credentials.
- `<all_urls>` content-script matches: discover translatable text and dynamic DOM updates on whichever website the user chooses. The extension does not request history, cookies, or network interception.
- `https://api.deepseek.com/*`: verify a user-supplied DeepSeek key, list compatible models, and send user-requested translation batches.
- `https://api.openai.com/*`: verify a user-supplied OpenAI key, list compatible models, and send user-requested translation batches.

## Code and execution

- Manifest version: 3.
- Remote executable code: No.
- External connections: only the two declared provider APIs.
- Translation proxy operated by the maintainer: No.
- Obfuscation: No.
- Bundled generated code: pinned PDF.js, PDF-LIB, fontkit, and webextension-polyfill assets documented in `THIRD_PARTY_NOTICES.md`.

## Data-use answers

Declare the following handled or transmitted data:

- **Website content:** text, short neighboring context, and protected brand terms selected for translation.
- **Authentication information:** the user's API key, sent only as authorization to the selected provider.
- **User-provided content:** selected text, explicitly submitted editable text, and extracted PDF text.

Do not declare browsing history, precise location, financial information, health information, personal communications, analytics, advertising data, or crash telemetry as separately collected product data. Page text can itself contain sensitive information, so the listing and privacy policy must not imply that all translated content is non-sensitive.

Certify:

- Data is used only to provide translation and user-controlled caching.
- Data is not sold or transferred for advertising, profiling, creditworthiness, or unrelated purposes.
- Maintainers do not receive provider keys or translated content.
- Data is sent over HTTPS directly to the provider selected by the user.
- Private-window content is not written to persistent cache storage.
- The Chrome Web Store Limited Use requirements are followed.

## Store-specific flags

- **Chrome Web Store:** website content, authentication information, and user-provided content; privacy policy required; Limited Use certification required.
- **Firefox Add-ons:** `websiteContent` and `authenticationInfo` are required data-collection permissions in the manifest; privacy policy required.
- **Microsoft Edge Add-ons:** accesses and transmits personal information: Yes; remote code: No; privacy policy required.
- **Opera Add-ons:** category Productivity; license MPL-2.0; support and privacy URLs required for a transparent listing.
- **Payment disclosure:** the extension is free and has no subscription, but provider API usage may require payment. Select the store option indicating a non-free external service may be required.
