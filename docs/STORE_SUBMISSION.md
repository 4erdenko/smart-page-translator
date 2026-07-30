# Store Submission Checklist

## Before tagging

- Verify that `LICENSE`, `package.json`, README, and contribution terms consistently identify MPL-2.0.
- Run `npm ci`, `npm run check`, and `npm audit`.
- Scan the current tree and complete Git history for credentials, personal data, local paths, captured pages, and site-specific fixtures.
- Verify `git status` contains no generated builds, browser profiles, IDE state, or local-only files.
- Test translation, all three page views, keyboard shortcuts, selected-text and editable-field translation, onboarding, PDF text extraction, layout preview, translated-PDF download, SPA navigation, private browsing, settings, and the popup in current Firefox and Chrome.
- Verify English and Russian UI localization and ensure every locale contains the same message keys.
- Verify that the repository, homepage, and issue-tracker URLs in `package.json` match the public remote.
- Enable GitHub private vulnerability reporting and publish `PRIVACY.md` at a stable public URL.
- Confirm the hosted privacy notice contains the Chrome Web Store Limited Use compliance statement.
- Verify every file in `store-assets/` with `npm run check:store-assets`.
- Copy localized listing text and reviewer answers from `docs/store/`.

## Firefox

- Build with `npm run package:firefox`.
- Keep the stable Gecko ID and increment the manifest version.
- Declare `authenticationInfo` and `websiteContent` as required data collection because the user-supplied key and selected page text go directly to the chosen provider.
- Explain the all-sites content script, configurable native context-menu command for selections and editable fields, provider-only host permissions, local cache, PDF workspace, and private-browsing behavior in the AMO listing.
- Run `npm run package:source` and upload the resulting source ZIP when Mozilla requests source.
- Tell reviewers to run `npm ci` followed by `npm run build:firefox` with Node.js 24 and npm 11.
- Include the exact upstream release and source links from `THIRD_PARTY_NOTICES.md` in reviewer notes.
- Explain that bundled PDF.js parses and renders files locally, while only grouped text and short neighboring-text context are sent after an explicit action. PDF-LIB and fontkit create the translated download locally from flattened page backgrounds and one subsetted searchable DejaVu Sans translation layer. Disclose that links, annotations, interactive forms, and digital signatures are not retained. Note that PDF.js and PDF-LIB are pinned upstream assets. The official CSP-safe fontkit browser module is bundled with a first-party PDF-LIB compatibility adapter; no third-party minified code is patched. The build pins and verifies the runtime dependency graph and rejects generated dynamic code. PDF.js narrowly requires four upstream lint warnings in its two files (`Function` construction and variable dynamic import), while project runtime source is separately tested to reject dynamic imports.

## Chrome

- Build with `npm run package:chrome`.
- State the single purpose as whole-page translation.
- Justify all-sites content-script access, `contextMenus`, and `unlimitedStorage`; document the three declared keyboard shortcuts and do not request unrelated permissions.
- Link the hosted `PRIVACY.md` from the Chrome Web Store listing and complete its data-use disclosures consistently.
- Keep the listing and focused first-run disclosure explicit about page-text, PDF-text, editable-text, and credential transmission.
- Upload the 128 px package icon, 440×280 promo tile, and at least one current 1280×800 screenshot from `store-assets/`.

## Release artifacts

- Create an annotated `v<package version>` tag on the reviewed commit, check it out with no staged or unstaged tracked changes, and run `npm run package:stores` once to create both browser packages, the Mozilla source package, and `artifacts/SHA256SUMS`. The command rejects a missing/mismatched tag or dirty tracked tree.
- Sign through the relevant browser store; do not distribute an unsigned ZIP as a permanent Firefox installation.
- Record SHA-256 checksums for uploaded archives.
- Tag only the reviewed commit and attach packages generated from that exact revision.
- Link each executable release to its exact public source tag as required by MPL-2.0.
- Verify that the README links to the signed Firefox and Chrome store releases.
