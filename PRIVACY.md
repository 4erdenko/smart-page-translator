# Privacy Notice

Effective date: July 25, 2026.

Smart Page Translator does not include analytics, advertising, or telemetry.

When translation is enabled for a website, the extension sends non-editable page text, short DOM context, and protected brand terms directly to the translation provider selected by the user: DeepSeek or OpenAI. Text selected on a page is sent only after the user explicitly invokes Translate from the selection popup or context menu. A focused form value or selected rich-editor text is sent only after the user explicitly invokes Translate this field; this text is never written to the translation cache. Automatic page translation continues to exclude form values and editable text. Same-origin embedded frames follow the website rule. Cross-origin frames remain disabled unless their own origin is explicitly listed under Always translate websites. Provider processing and retention are governed by the user's account and that provider's terms. Scripts, styles, images, and browsing history are not sent for translation.

The PDF workspace reads a file locally with bundled PDF.js code. PDF bytes, the filename, images, annotations, coordinates, and layout are not sent to a translation provider. Grouped text blocks and short neighboring-text context are sent only after the user presses Translate document. The user can disable caching for that operation before it starts. Page previews and the downloadable translated PDF are created locally with bundled PDF.js, PDF-LIB, and fontkit code; no additional document data is transmitted during export.

API keys, website rules, settings, user-defined protected terms, source text, and translated text are stored locally through the browser extension storage API. Keys are available only to extension contexts and are never displayed after saving. A key is sent only to the selected provider as an authorization credential. Firefox declares this transfer as `authenticationInfo` and translated page text as `websiteContent` in its built-in data-collection consent metadata. Local extension storage is not a hardware-backed secrets vault; restricted keys with conservative spending limits are recommended.

The translation cache is limited by phrase count and serialized byte size. Its default limit is 16,000 phrases, and its hard serialized-size limit is 16 MiB. Users can lower the phrase limit, disable PDF caching per operation, or clear the cache at any time from Settings. Removing the extension also allows the browser to remove its local data according to browser policy.

Private/incognito page text and translations bypass the persistent cache. The popup does not save website rules from private tabs; one-time translation remains available for the current page. Existing global language and website rules may still determine whether translation starts, but no private-page content is added to extension storage.

The extension contacts only the selected provider for model discovery and translation. The project maintainers do not operate a translation proxy and do not receive page text or provider keys. The extension does not sell or share data with any additional party.

## Limited Use

Smart Page Translator's use and transfer of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Page text, explicitly submitted editable text, extracted PDF text, short DOM context, and protected brand terms are used only to provide user-requested translation and user-controlled caching. Provider credentials are used only to authenticate requests to the selected translation provider. This data is not used for advertising, profiling, creditworthiness, or any unrelated purpose.

## Privacy questions

For a non-sensitive privacy question, open a repository issue without including page content, private URLs, account details, or credentials. Use GitHub private vulnerability reporting from the repository **Security** tab when a report contains sensitive information or describes unintended data exposure.
