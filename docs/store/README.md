# Store Publication Kit

This directory contains copy-and-paste metadata for the first public release.

## Release channels

| Store | Package | Listing copy | Status |
| --- | --- | --- | --- |
| Chrome Web Store | `artifacts/smart-page-translator-chrome.zip` | English and Russian | Ready for dashboard upload |
| Firefox Add-ons | `artifacts/smart-page-translator-firefox.zip` | English and Russian | Ready for AMO upload |
| Microsoft Edge Add-ons | Chrome package | English and Russian | Ready for Partner Center upload |
| Opera Add-ons | Chrome package | English and Russian | Ready for Opera upload |

Brave and Vivaldi install extensions from the Chrome Web Store, so they do not need separate submissions. Safari is not included because it requires a separate Safari Web Extension app wrapper, Xcode project, Apple signing, and platform-specific testing.

## Files

- `listing-en.md` and `listing-ru.md` contain the localized store descriptions.
- `disclosures.md` contains the single-purpose statement, permission justifications, data-use answers, and store flags.
- `reviewer-notes.md` contains private certification notes and functional test steps.
- `../../store-assets/` contains validated icons, promo images, and localized screenshots.

Generate all upload archives and checksums with:

```bash
npm run package:stores
```

Use the public privacy-policy URL:

`https://github.com/4erdenko/smart-page-translator/blob/main/PRIVACY.md`

Never paste a real provider key into this repository. If a reviewer requires credentials, create a temporary spend-limited key and provide it only in the store's private reviewer-notes field.
