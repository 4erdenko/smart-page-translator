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
    /function writeCspSafeFontkit\(destinationPath\)/u
  );
  assert.match(
    buildSource,
    /"fontkit\.umd\.min\.js"/u
  );
  assert.match(
    buildSource,
    /"LICENSE\.fontkit\.txt"/u
  );
});
