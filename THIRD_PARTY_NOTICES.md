# Third-Party Notices

Smart Page Translator is licensed under the Mozilla Public License 2.0. This document lists code and fonts distributed with the extension under separate upstream copyrights.

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

## fontkit

- Version: 2.0.4
- Project: https://github.com/foliojs/fontkit
- Release: https://github.com/foliojs/fontkit/releases/tag/v2.0.4
- Source archive: https://github.com/foliojs/fontkit/archive/refs/tags/v2.0.4.tar.gz
- npm package: https://www.npmjs.com/package/fontkit/v/2.0.4
- License: MIT

The build bundles the official CSP-safe browser module with esbuild and a small
first-party compatibility adapter for PDF-LIB's legacy subset-stream interface.
It does not patch or post-process third-party code. The build fails if the
reviewed runtime dependency graph changes or if the output contains dynamic
`eval`, `Function`, or `import()` calls. Fontkit is used only during local PDF
export to subset and embed the bundled DejaVu Sans fonts.

The fontkit browser bundle also contains its locked runtime dependencies:
@swc/helpers 0.5.23 (Apache-2.0), base64-js 1.5.1 (MIT), brotli 1.3.3
(package MIT; bundled decoder files Apache-2.0), clone 2.1.2 (MIT), dfa 1.2.0
(MIT), fast-deep-equal 3.1.3 (MIT), restructure 3.0.2 (MIT), tiny-inflate
1.0.3 (MIT), tslib 2.8.1 (0BSD), unicode-properties 1.4.1 (MIT), and
unicode-trie 2.0.0 (MIT). Their package-specific license texts and attribution
are included under package/version headers in `vendor/LICENSE.fontkit.txt`.
For fontkit, brotli, and dfa, which do not ship standalone license files in
their npm archives, the notice records the npm license declaration and package
author attribution; brotli's bundled Google decoder notice and full Apache
License 2.0 text are included separately.

## DejaVu Fonts

- Package version: 2.37.3 (DejaVu Fonts 2.37)
- Project: https://github.com/senotrusov/dejavu-fonts-ttf
- Release: https://github.com/senotrusov/dejavu-fonts-ttf/releases/tag/v2.37.3
- Source archive: https://github.com/senotrusov/dejavu-fonts-ttf/archive/refs/tags/v2.37.3.tar.gz
- npm package: https://www.npmjs.com/package/dejavu-fonts-ttf/v/2.37.3
- License: Bitstream Vera Fonts Copyright and Arev Fonts Copyright

The build copies DejaVu Sans Regular and Bold from the locked npm package for
local searchable PDF export. The package license is included as
`vendor/LICENSE.dejavu-fonts.txt`.

Development-only dependencies are listed with exact versions and integrity hashes in `package-lock.json`; they are not bundled into the extension.
