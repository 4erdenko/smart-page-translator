# Store Submission Checklist

## Before tagging

- Verify that `LICENSE`, `package.json`, README, and contribution terms consistently identify MPL-2.0.
- Run `npm ci`, `npm run check`, and `npm audit`.
- Scan the current tree and complete Git history for credentials, personal data, local paths, captured pages, and site-specific fixtures.
- Verify `git status` contains no generated builds, browser profiles, IDE state, or local-only files.
- Test translation, restoration, SPA navigation, private browsing, settings, and the popup in current Firefox and Chrome.
- Add the real repository, homepage, and issue-tracker URLs to `package.json` after the public remote exists.
- Enable GitHub private vulnerability reporting and publish `PRIVACY.md` at a stable public URL.

## Firefox

- Build with `npm run package:firefox`.
- Keep the stable Gecko ID and increment the manifest version.
- Declare `authenticationInfo` and `websiteContent` as required data collection because the user-supplied key and selected page text go directly to the chosen provider.
- Explain the all-sites content script, provider-only host permissions, local cache, and private-browsing behavior in the AMO listing.
- Submit readable source with the lockfile and these build instructions when Mozilla requests source.

## Chrome

- Build with `npm run package:chrome`.
- State the single purpose as whole-page translation.
- Justify all-sites content-script access and `unlimitedStorage`; do not request unrelated permissions.
- Link the hosted `PRIVACY.md` from the Chrome Web Store listing and complete its data-use disclosures consistently.

## Release artifacts

- Sign through the relevant browser store; do not distribute an unsigned ZIP as a permanent Firefox installation.
- Record SHA-256 checksums for uploaded archives.
- Tag only the reviewed commit and attach packages generated from that exact revision.
- Link each executable release to its exact public source tag as required by MPL-2.0.
- Replace the README installation placeholder with signed Firefox and Chrome store links.
