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

## PDF.js

- Version: 6.1.200
- Project: https://github.com/mozilla/pdf.js
- Release: https://github.com/mozilla/pdf.js/releases/tag/v6.1.200
- Source archive: https://github.com/mozilla/pdf.js/archive/refs/tags/v6.1.200.tar.gz
- npm package: https://www.npmjs.com/package/pdfjs-dist/v/6.1.200
- License: Apache License 2.0

The build copies the official minified legacy-compatible display library, worker, character maps, standard fonts, and WASM assets from the locked npm dependency without modification. Its license is included as `vendor/LICENSE.pdfjs.txt`.

## PDF-LIB

- Version: 1.17.1
- Project: https://github.com/Hopding/pdf-lib
- Release: https://github.com/Hopding/pdf-lib/releases/tag/v1.17.1
- Source archive: https://github.com/Hopding/pdf-lib/archive/refs/tags/v1.17.1.tar.gz
- npm package: https://www.npmjs.com/package/pdf-lib/v/1.17.1
- License: MIT

The build copies the official minified browser bundle from the locked npm dependency without modification. Its license is included as `vendor/LICENSE.pdf-lib.txt`.

## @pdf-lib/fontkit

- Version: 1.1.1
- Project: https://github.com/Hopding/fontkit
- npm package: https://www.npmjs.com/package/@pdf-lib/fontkit/v/1.1.1
- License: MIT

The build derives `vendor/fontkit.js` from the official minified browser bundle in the locked npm dependency. It applies two deterministic CSP compatibility substitutions: a legacy `Function`-based bind fallback becomes a closure, and an unused intrinsic `eval` reference becomes `undefined`. The build fails if the pinned upstream byte patterns change. The packaged `vendor/LICENSE.fontkit.txt` records the MIT terms and attribution. Fontkit is used only during local PDF export to subset and embed the bundled Liberation Sans fonts.

Development-only dependencies are listed with exact versions and integrity hashes in `package-lock.json`; they are not bundled into the extension.
