const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
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
