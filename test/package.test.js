const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");

test("creates byte-identical packages without timestamped directory entries", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "smart-translation-package-"));
  const sourceDirectory = path.join(temporaryDirectory, "source");
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }));
  await mkdir(path.join(sourceDirectory, "nested"), { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceDirectory, "manifest.json"), "{\"manifest_version\":3}\n", "utf8"),
    writeFile(path.join(sourceDirectory, "nested", "background.js"), "void 0;\n", "utf8")
  ]);
  const { createArchive } = await import("../scripts/package.mjs");
  const first = await createArchive(sourceDirectory);
  const second = await createArchive(sourceDirectory);
  const parsed = await JSZip.loadAsync(first);

  assert.equal(Buffer.compare(first, second), 0);
  assert.deepEqual(Object.keys(parsed.files).sort(), ["manifest.json", "nested/background.js"]);
});

test("rejects a written archive that differs from generated content", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "smart-translation-package-"));
  const outputPath = path.join(temporaryDirectory, "archive.zip");
  const generatedContent = Buffer.from("generated archive");
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }));
  const { readVerifiedArchive } = await import("../scripts/package.mjs");
  await writeFile(outputPath, generatedContent);

  assert.deepEqual(await readVerifiedArchive(outputPath, generatedContent), generatedContent);
  await writeFile(outputPath, "corrupted archive");
  await assert.rejects(
    readVerifiedArchive(outputPath, generatedContent),
    /Written archive does not match generated content/u
  );
});

test("creates a deterministic source archive from explicitly selected files", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "smart-translation-source-package-"));
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }));
  await mkdir(path.join(temporaryDirectory, "nested"), { recursive: true });
  await Promise.all([
    writeFile(path.join(temporaryDirectory, "package-lock.json"), "{}\n", "utf8"),
    writeFile(path.join(temporaryDirectory, "nested", "background.js"), "void 0;\n", "utf8"),
    writeFile(path.join(temporaryDirectory, "local-secret.txt"), "not packaged\n", "utf8")
  ]);
  const { createSourceArchive } = await import("../scripts/package.mjs");
  const selectedFiles = ["nested/background.js", "package-lock.json"];
  const first = await createSourceArchive(temporaryDirectory, selectedFiles);
  const second = await createSourceArchive(temporaryDirectory, [...selectedFiles].reverse());
  const parsed = await JSZip.loadAsync(first);

  assert.equal(Buffer.compare(first, second), 0);
  assert.deepEqual(Object.keys(parsed.files).sort(), selectedFiles.sort());
  assert.equal(Object.hasOwn(parsed.files, "local-secret.txt"), false);
});

test("source packaging excludes repository automation and store artwork", async () => {
  const { shouldIncludeSourceFile } = await import("../scripts/package.mjs");

  assert.equal(shouldIncludeSourceFile("src/background.js"), true);
  assert.equal(shouldIncludeSourceFile("AGENTS.md"), false);
  assert.equal(shouldIncludeSourceFile(".github/workflows/ci.yml"), false);
  assert.equal(shouldIncludeSourceFile("store-assets/en/01-page-translation.png"), false);
});

test("rejects source archive paths outside the project root", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "smart-translation-source-package-"));
  context.after(() => rm(temporaryDirectory, { force: true, recursive: true }));
  const { createSourceArchive } = await import("../scripts/package.mjs");

  for (const invalidPath of ["../outside.txt", "/outside.txt", "C:\\outside.txt"]) {
    await assert.rejects(
      createSourceArchive(temporaryDirectory, [invalidPath]),
      /Invalid source path/u
    );
  }
});

test("includes locale resources, UI pages, and shared helpers in browser builds", async () => {
  const { getReleaseSourceFiles } = await import("../scripts/build.mjs");

  for (const target of ["firefox", "chrome"]) {
    const files = getReleaseSourceFiles(target);
    assert.ok(files.includes("_locales/en/messages.json"));
    assert.ok(files.includes("_locales/ru/messages.json"));
    assert.ok(files.includes("lib/document-core.js"));
    assert.ok(files.includes("lib/ui-i18n.js"));
    assert.ok(files.includes("onboarding/onboarding.html"));
    assert.ok(files.includes("pdf/pdf.html"));
  }
});

test("runtime source does not use dynamic imports", async () => {
  const { getReleaseSourceFiles } = await import("../scripts/build.mjs");
  const runtimeFiles = getReleaseSourceFiles("firefox").filter((file) => file.endsWith(".js"));
  const sources = await Promise.all(runtimeFiles.map((file) => readFile(
    path.join(__dirname, "..", "src", file),
    "utf8"
  )));

  for (let index = 0; index < sources.length; index += 1) {
    assert.doesNotMatch(sources[index], /\bimport\s*\(/u, runtimeFiles[index]);
  }
});

test("builds the browser-compatible PDF.js distribution", async () => {
  const buildSource = await readFile(
    path.join(__dirname, "..", "scripts", "build.mjs"),
    "utf8"
  );
  const packageMetadata = JSON.parse(await readFile(
    path.join(__dirname, "..", "package.json"),
    "utf8"
  ));

  assert.match(
    buildSource,
    /"pdfjs-dist", "legacy", "build", "pdf\.min\.mjs"/u
  );
  assert.match(
    buildSource,
    /"pdfjs-dist", "legacy", "build", "pdf\.worker\.min\.mjs"/u
  );
  assert.equal(packageMetadata.engines.node, ">=22.13.0");
});

test("bundles PDF-LIB locally for translated PDF export", async () => {
  const buildSource = await readFile(
    path.join(__dirname, "..", "scripts", "build.mjs"),
    "utf8"
  );
  const packageMetadata = JSON.parse(await readFile(
    path.join(__dirname, "..", "package.json"),
    "utf8"
  ));

  assert.equal(packageMetadata.dependencies["pdf-lib"], "1.17.1");
  assert.equal(packageMetadata.dependencies["dejavu-fonts-ttf"], "2.37.3");
  assert.match(
    buildSource,
    /"pdf-lib", "dist", "pdf-lib\.min\.js"/u
  );
  assert.match(
    buildSource,
    /"pdf-lib", "LICENSE\.md"/u
  );
  assert.match(
    buildSource,
    /async function buildFontkit\(destinationPath\)/u
  );
  assert.match(
    buildSource,
    /globalName: "fontkit"/u
  );
  assert.match(
    buildSource,
    /"LICENSE\.fontkit\.txt"/u
  );
  assert.match(
    buildSource,
    /"dejavu-fonts-ttf", "ttf", fontFile/u
  );
  assert.match(
    buildSource,
    /"LICENSE\.dejavu-fonts\.txt"/u
  );
  assert.equal(packageMetadata.dependencies.fontkit, "2.0.4");
  assert.equal(packageMetadata.devDependencies.esbuild, "0.28.1");
  assert.equal(packageMetadata.dependencies["@pdf-lib/fontkit"], undefined);
  assert.doesNotMatch(buildSource, /\.replace\(/u);
});

test("includes the reviewed fontkit runtime license set", async () => {
  const {
    createFontkitNotices,
    getFontkitRuntimeLicensePackages
  } = await import("../scripts/build.mjs");
  const expectedPackages = [
    [
      "@swc/helpers",
      "0.5.23",
      "node_modules/@swc/helpers",
      ["node_modules/@swc/helpers/LICENSE"]
    ],
    ["base64-js", "1.5.1", "node_modules/base64-js", ["node_modules/base64-js/LICENSE"]],
    [
      "brotli",
      "1.3.3",
      "node_modules/brotli",
      ["third_party/LICENSE.brotli.txt", "node_modules/@swc/helpers/LICENSE"]
    ],
    [
      "clone",
      "2.1.2",
      "node_modules/fontkit/node_modules/clone",
      ["node_modules/fontkit/node_modules/clone/LICENSE"]
    ],
    ["dfa", "1.2.0", "node_modules/dfa", ["third_party/LICENSE.dfa.txt"]],
    [
      "fast-deep-equal",
      "3.1.3",
      "node_modules/fast-deep-equal",
      ["node_modules/fast-deep-equal/LICENSE"]
    ],
    ["fontkit", "2.0.4", "node_modules/fontkit", ["third_party/LICENSE.fontkit.txt"]],
    [
      "restructure",
      "3.0.2",
      "node_modules/restructure",
      ["node_modules/restructure/LICENSE"]
    ],
    [
      "tiny-inflate",
      "1.0.3",
      "node_modules/tiny-inflate",
      ["node_modules/tiny-inflate/LICENSE"]
    ],
    [
      "tslib",
      "2.8.1",
      "node_modules/@swc/helpers/node_modules/tslib",
      ["node_modules/@swc/helpers/node_modules/tslib/LICENSE.txt"]
    ],
    [
      "unicode-properties",
      "1.4.1",
      "node_modules/unicode-properties",
      ["node_modules/unicode-properties/LICENSE"]
    ],
    [
      "unicode-trie",
      "2.0.0",
      "node_modules/unicode-trie",
      ["node_modules/unicode-trie/LICENSE"]
    ]
  ];
  const packages = getFontkitRuntimeLicensePackages();

  assert.deepEqual(
    packages.map(({ licenseFiles, name, packageDirectory, version }) => (
      [name, version, packageDirectory, licenseFiles]
    )),
    expectedPackages
  );

  const sections = (await createFontkitNotices())
    .trim()
    .split(`\n\n${"=".repeat(80)}\n\n`);

  assert.equal(sections.length, packages.length);

  for (let index = 0; index < packages.length; index += 1) {
    const { licenseFiles, name, version } = packages[index];
    assert.ok(sections[index].startsWith(`${name}@${version}\n\n`));

    for (const licenseFile of licenseFiles) {
      const license = await readFile(path.join(__dirname, "..", licenseFile), "utf8");
      assert.ok(sections[index].includes(license.trim()));
    }
  }
});

test("embeds the required Cyrillic, currency, and checkbox glyphs", async () => {
  const { PDFDocument } = require("pdf-lib");
  const fontkit = await import("../scripts/fontkit-adapter.mjs");
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const page = document.addPage([320, 120]);
  const requiredText = "Привет € ₽ ₴ ✓ ☐ ☑ ☒";

  for (const [index, fontFile] of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].entries()) {
    const fontBytes = await readFile(path.join(
      __dirname,
      "..",
      "node_modules",
      "dejavu-fonts-ttf",
      "ttf",
      fontFile
    ));
    const font = await document.embedFont(fontBytes, { subset: true });

    for (const character of Array.from(requiredText)) {
      assert.ok(/\s/u.test(character) || font.getCharacterSet().includes(character.codePointAt(0)));
    }

    page.drawText(requiredText, { font, size: 16, x: 24, y: 72 - index * 28 });
  }

  const bytes = await document.save();
  const loaded = await PDFDocument.load(bytes);

  assert.equal(loaded.getPageCount(), 1);
  assert.ok(bytes.length > 5000);
});

test("validates store tag, version, and HEAD identity", async () => {
  const { validateStoreReleaseIdentity } = await import("../scripts/package.mjs");
  const packageMetadata = JSON.parse(await readFile(
    path.join(__dirname, "..", "package.json"),
    "utf8"
  ));
  const identity = {
    head: "abc123",
    tag: `v${packageMetadata.version}`,
    tagCommit: "abc123",
    tagType: "tag",
    version: packageMetadata.version
  };

  assert.doesNotThrow(() => validateStoreReleaseIdentity(identity));
  assert.throws(
    () => validateStoreReleaseIdentity({ ...identity, tag: "v0.0.0" }),
    /exact release tag/u
  );
  assert.throws(
    () => validateStoreReleaseIdentity({ ...identity, tagType: "commit" }),
    /annotated tag/u
  );
  assert.throws(
    () => validateStoreReleaseIdentity({ ...identity, tagCommit: "def456" }),
    /point at HEAD/u
  );
});
