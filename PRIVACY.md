# Privacy Notice

Smart Page Translator does not include analytics, advertising, or telemetry.

When translation is enabled for a website, the extension sends non-editable page text, short DOM context, and protected brand terms directly to the translation provider selected by the user: DeepSeek or OpenAI. Same-origin embedded frames follow the website rule. Cross-origin frames remain disabled unless their own origin is explicitly listed under Always translate websites. Provider processing and retention are governed by the user's account and that provider's terms. Form values, editable text, scripts, styles, images, and browsing history are not sent for translation.

API keys, website rules, settings, source text, and translated text are stored locally through the browser extension storage API. Keys are available only to extension contexts and are never displayed after saving. A key is sent only to the selected provider as an authorization credential. Firefox declares this transfer as `authenticationInfo` and translated page text as `websiteContent` in its built-in data-collection consent metadata. Local extension storage is not a hardware-backed secrets vault; restricted keys with conservative spending limits are recommended.

The translation cache is limited by phrase count and serialized byte size. Users can clear it at any time from Settings. Removing the extension also allows the browser to remove its local data according to browser policy.

Private/incognito page text and translations bypass the persistent cache. The popup does not save website rules from private tabs; one-time translation remains available for the current page. Existing global language and website rules may still determine whether translation starts, but no private-page content is added to extension storage.

The extension contacts only the selected provider for model discovery and translation. It does not sell or share data with any additional party.
