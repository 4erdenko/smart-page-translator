# Third-Party Notices

Smart Page Translator is licensed under the Mozilla Public License 2.0. This document lists code distributed with the extension under a separate upstream copyright.

The packaged extension includes:

## webextension-polyfill

- Version: 0.12.0
- Project: https://github.com/mozilla/webextension-polyfill
- Release: https://github.com/mozilla/webextension-polyfill/releases/tag/0.12.0
- Source archive: https://github.com/mozilla/webextension-polyfill/archive/refs/tags/0.12.0.tar.gz
- npm package: https://www.npmjs.com/package/webextension-polyfill/v/0.12.0
- License: Mozilla Public License 2.0

The build copies the official release file from the locked npm dependency without modification and includes its license as `vendor/LICENSE.webextension-polyfill.txt`. The exact upstream release, source archive, and npm package are linked above for reproducible review.

Development-only dependencies are listed with exact versions and integrity hashes in `package-lock.json`; they are not bundled into the extension.
