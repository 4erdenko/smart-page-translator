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

## Firefox

- Build with `npm run package:firefox`.
- Keep the stable Gecko ID and increment the manifest version.
- Declare `authenticationInfo` and `websiteContent` as required data collection because the user-supplied key and selected page text go directly to the chosen provider.
- Explain the all-sites content script, explicit selection and editable-field context menus, provider-only host permissions, local cache, PDF workspace, and private-browsing behavior in the AMO listing.
- Run `npm run package:source` and upload the resulting source ZIP when Mozilla requests source.
- Tell reviewers to run `npm ci` followed by `npm run build:firefox` with Node.js 24 and npm 11.
- Include the exact upstream release and source links from `THIRD_PARTY_NOTICES.md` in reviewer notes.
- Explain that bundled PDF.js parses and renders files locally, while only grouped text and short neighboring-text context are sent after an explicit action. PDF-LIB and @pdf-lib/fontkit create the translated download locally from flattened page backgrounds and one subsetted searchable translation layer. Disclose that links, annotations, interactive forms, and digital signatures are not retained. Note that PDF.js and PDF-LIB are pinned upstream assets. Fontkit is also pinned, with two deterministic build-time substitutions that remove legacy dynamic-code paths forbidden by the extension CSP; the build fails if those reviewed upstream patterns change. PDF.js narrowly requires four upstream lint warnings in its two files (`Function` construction and variable dynamic import), while project runtime source is separately tested to reject dynamic imports.

## Chrome

- Build with `npm run package:chrome`.
- State the single purpose as whole-page translation.
- Justify all-sites content-script access, `contextMenus`, and `unlimitedStorage`; document the three declared keyboard shortcuts and do not request unrelated permissions.
- Link the hosted `PRIVACY.md` from the Chrome Web Store listing and complete its data-use disclosures consistently.
- Prominently disclose page-text and credential transmission before installation and obtain affirmative informed consent.

## Release artifacts

- Sign through the relevant browser store; do not distribute an unsigned ZIP as a permanent Firefox installation.
- Record SHA-256 checksums for uploaded archives.
- Tag only the reviewed commit and attach packages generated from that exact revision.
- Link each executable release to its exact public source tag as required by MPL-2.0.
- Replace the README installation placeholder with signed Firefox and Chrome store links.
