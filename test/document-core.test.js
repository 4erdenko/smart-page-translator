const test = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { PDFDocument } = require("pdf-lib");
const {
  applyDocumentTranslationSegment,
  createDocumentTranslationSegments,
  createTranslationBatches,
  createPdfTextBlocks,
  extractPdfText,
  getBoundedPdfRenderScale,
  getPdfTextMaskRectangle,
  getTranslatedPagePreviewMode,
  isHorizontalPdfTextTransform,
  isSupportedPdfTextTransform,
  selectPdfBackgroundChannels,
  splitDocumentText
} = require("../src/lib/document-core.js");

test("extracts readable text from PDF text items", () => {
  assert.equal(
    extractPdfText([
      { str: "Hello", hasEOL: false },
      { str: ",", hasEOL: false },
      { str: "world", hasEOL: true },
      { str: "Second line", hasEOL: true }
    ]),
    "Hello, world\nSecond line"
  );
});

test("splits long document text without losing content", () => {
  const source = "First paragraph.\n\nSecond paragraph with more text.";
  const chunks = splitDocumentText(source, 24);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("").replace(/\s+/gu, ""), source.replace(/\s+/gu, ""));
  assert.ok(chunks.every((chunk) => chunk.length <= 24));
});

test("creates bounded independently addressable document segments", () => {
  const source = "Document sentence. ".repeat(1000).trim();
  const segments = createDocumentTranslationSegments("p1b0", source);

  assert.ok(segments.length > 2);
  assert.ok(segments.every(({ count }) => count === segments.length));
  assert.ok(segments.every(({ text }) => text.length <= 7000));
  assert.deepEqual(
    segments.map(({ id, index }) => ({ id, index })),
    segments.map((_, index) => ({ id: `p1b0:s${index}`, index }))
  );
  assert.equal(
    segments.map(({ separator, text }) => `${text}${separator}`).join("").replace(/\s+/gu, " "),
    source.replace(/\s+/gu, " ")
  );
});

test("does not insert whitespace into a split unbroken document token", () => {
  const source = "A".repeat(15000);
  const segments = createDocumentTranslationSegments("p1b0", source);

  assert.equal(segments.length, 3);
  assert.equal(segments.map(({ separator, text }) => `${text}${separator}`).join(""), source);
});

test("reassembles out-of-order document segments and releases partial state", () => {
  const block = {
    translation: "",
    translationSegments: [
      { separator: " ", translation: "" },
      { separator: "\n", translation: "" },
      { separator: "", translation: "" }
    ]
  };

  assert.equal(applyDocumentTranslationSegment(block, 2, 3, "third"), false);
  assert.equal(applyDocumentTranslationSegment(block, 0, 3, "first"), false);
  assert.equal(applyDocumentTranslationSegment(block, 1, 3, "second"), true);
  assert.equal(block.translation, "first second\nthird");
  assert.equal(Object.hasOwn(block, "translationSegments"), false);
});

test("batches document segments by count and request characters", () => {
  const items = [
    { id: "a", text: "1234", context: "x" },
    { id: "b", text: "5678", context: "x" },
    { id: "c", text: "90", context: "x" }
  ];

  assert.deepEqual(
    createTranslationBatches(items, 2, 10).map((batch) => batch.map(({ id }) => id)),
    [["a", "b"], ["c"]]
  );
});

test("preserves zero-text PDF pages after the document translation completes", () => {
  assert.equal(getTranslatedPagePreviewMode([], false), "pending");
  assert.equal(getTranslatedPagePreviewMode([], true), "original");
  assert.equal(
    getTranslatedPagePreviewMode([{ translation: "Translated" }], false),
    "translated"
  );
});

test("PDF page refresh uses a precomputed document translation state", async () => {
  const source = await readFile(require.resolve("../src/pdf/pdf.js"), "utf8");
  const stateStart = source.indexOf("function isDocumentTranslated(");
  const stateEnd = source.indexOf("\n  function setBusy(", stateStart);
  const stateSource = source.slice(stateStart, stateEnd);
  const refreshStart = source.indexOf("function refreshTranslatedPreview(");
  const refreshEnd = source.indexOf("\n  async function renderPagePreview(", refreshStart);
  const refreshSource = source.slice(refreshStart, refreshEnd);

  assert.match(stateSource, /documentState\?\.translationComplete === true/u);
  assert.doesNotMatch(stateSource, /flatMap|every/u);
  assert.match(
    refreshSource,
    /function refreshTranslatedPreview\(page, documentTranslated = false\)/u
  );
  assert.doesNotMatch(refreshSource, /isDocumentTranslated\(/u);
  assert.match(
    source,
    /documentState\.translationComplete = true;\s+const documentTranslated = isDocumentTranslated\(\);\s+updateDocumentSummary\(\);\s+for \(const page of documentState\.pages\) \{\s+refreshTranslatedPreview\(page, documentTranslated\);/u
  );
});

test("PDF export rejects characters missing from the bundled font before rendering", async () => {
  const source = await readFile(require.resolve("../src/pdf/pdf.js"), "utf8");
  const helperStart = source.indexOf("function findUnsupportedPdfExportCharacter(");
  const helperEnd = source.indexOf("\n  function assertPdfExportGlyphCoverage(", helperStart);
  const helper = vm.runInNewContext(`(${source.slice(helperStart, helperEnd).trim()})`);
  const supportedText = "Text Перевод";
  const supportedCodePoints = new Set(Array.from(supportedText, (character) => character.codePointAt(0)));
  const downloadStart = source.indexOf("async function downloadTranslatedPdf(");
  const downloadEnd = source.indexOf("\n  async function loadSettings(", downloadStart);
  const downloadSource = source.slice(downloadStart, downloadEnd);

  assert.equal(helper(`${supportedText}\n`, supportedCodePoints), "");
  assert.equal(helper(`${supportedText} 中`, supportedCodePoints), "中");
  assert.equal(helper(`${supportedText} 😀`, supportedCodePoints), "😀");
  assert.match(
    downloadSource,
    /const exportFonts = await loadPdfExportFonts\(outputDocument\);\s+assertPdfExportGlyphCoverage\(documentState\.pages, exportFonts\);\s+let embeddedImageBytes = 0;/u
  );
});

test("PDF settings refresh preserves export errors and completed status", async () => {
  const source = await readFile(require.resolve("../src/pdf/pdf.js"), "utf8");
  const loadStart = source.indexOf("async function loadSettings(");
  const loadEnd = source.indexOf("\n  function handleFile(", loadStart);
  const loadSource = source.slice(loadStart, loadEnd);
  const exportErrorStatus = loadSource.indexOf("if (exportError)");
  const translatedStatus = loadSource.indexOf('else if (isDocumentTranslated())');
  const missingKeyStatus = loadSource.indexOf("else if (!hasApiKey)");

  assert.ok(exportErrorStatus >= 0);
  assert.ok(translatedStatus > exportErrorStatus);
  assert.ok(missingKeyStatus > translatedStatus);
  assert.match(
    source,
    /catch \(error\) \{\s+exportError = String\(error\?\.message \|\| error\);\s+showProgress\(exportError\);/u
  );
  assert.match(
    loadSource,
    /showProgress\(t\("pdfTranslated", null, "Translated PDF is ready to review or download\."\)\);/u
  );
});

test("expands PDF text masks to integer canvas pixels", () => {
  assert.deepEqual(
    getPdfTextMaskRectangle(
      { fontSize: 8, height: 8, width: 30.3, x: 10.4, y: 20.2 },
      2,
      200,
      200
    ),
    { height: 26, width: 68, x: 17, y: 35 }
  );
  assert.deepEqual(
    getPdfTextMaskRectangle({ height: 8, width: 30, x: 10, y: 20 }, 0, 200, 200),
    { height: 0, width: 0, x: 0, y: 0 }
  );
});

test("uses the dominant sampled PDF background color", () => {
  assert.deepEqual(
    selectPdfBackgroundChannels([
      [255, 255, 255, 255],
      [254, 255, 255, 255],
      [255, 254, 255, 255],
      [253, 254, 255, 255],
      [186, 186, 186, 255],
      [12, 18, 12, 255]
    ]),
    [255, 255, 255]
  );
});

test("groups PDF fragments into visual blocks without mixing form fields", () => {
  const blocks = createPdfTextBlocks([
    { text: "Contact", x: 80, y: 80, width: 52, height: 11 },
    { text: "details", x: 138, y: 80, width: 38, height: 11 },
    { text: "must be supplied", x: 80, y: 94, width: 110, height: 11 },
    { text: "Name: Anne Example", x: 80, y: 130, width: 120, height: 11 },
    { text: "Email: anne@example.com", x: 80, y: 144, width: 150, height: 11 },
    { text: "A complete sentence.", x: 80, y: 180, width: 130, height: 11 },
    { text: "A separate paragraph.", x: 80, y: 194, width: 140, height: 11 }
  ], 595);

  assert.deepEqual(
    blocks.map(({ text }) => text),
    [
      "Contact details must be supplied",
      "Name: Anne Example",
      "Email: anne@example.com",
      "A complete sentence.",
      "A separate paragraph."
    ]
  );
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[0].x, 80);
  assert.equal(blocks[0].height, 25);
});

test("keeps parallel PDF columns in separate visual blocks", () => {
  const blocks = createPdfTextBlocks([
    { text: "Left heading", x: 40, y: 60, width: 90, height: 11 },
    { text: "Right heading", x: 330, y: 60, width: 95, height: 11 },
    { text: "Left body", x: 40, y: 74, width: 75, height: 11 },
    { text: "Right body", x: 330, y: 74, width: 80, height: 11 }
  ], 595);

  assert.deepEqual(
    blocks.map(({ text }) => text),
    ["Left heading Left body", "Right heading Right body"]
  );
  assert.ok(blocks.every(({ text }) => !/Left.*Right|Right.*Left/u.test(text)));
});

test("accepts only forward horizontal PDF display transforms", () => {
  assert.equal(isHorizontalPdfTextTransform([12, 0, 0, 12, 30, 40]), true);
  assert.equal(isHorizontalPdfTextTransform([0, 12, -12, 0, 30, 40]), false);
  assert.equal(isHorizontalPdfTextTransform([0, 12, -12, 0, 30, 40], true), true);
  assert.equal(isHorizontalPdfTextTransform(null), false);
  assert.equal(
    isSupportedPdfTextTransform([12, 0, 0, 12, 30, 40]),
    true
  );
  assert.equal(
    isSupportedPdfTextTransform([0, -12, 12, 0, 30, 40], true),
    true
  );
  assert.equal(
    isSupportedPdfTextTransform([0, 12, 12, 0, 420, 30]),
    false
  );
  assert.equal(
    isSupportedPdfTextTransform([-12, 0, 0, 12, 270, 40]),
    false
  );
  assert.equal(
    isSupportedPdfTextTransform([8, 8, -8, 8, 30, 40]),
    false
  );
});

test("bounds PDF rendering by both pixels and canvas dimensions", () => {
  assert.equal(
    getBoundedPdfRenderScale(595, 842, 2, 4_000_000, 16_384),
    2
  );
  const scale = getBoundedPdfRenderScale(
    100_000,
    100_000,
    2,
    12_000_000,
    16_384
  );

  assert.ok(scale > 0 && scale < 0.5);
  assert.ok(100_000 * scale <= 16_384);
  assert.ok(100_000 * 100_000 * scale * scale <= 12_000_000);
  assert.equal(getBoundedPdfRenderScale(Infinity, 100, 2, 12_000_000, 16_384), 0);
  assert.equal(getBoundedPdfRenderScale(100, 0, 2, 12_000_000, 16_384), 0);
});

test("embeds searchable Unicode translations in exported PDFs", async () => {
  const fontkit = await import("../scripts/fontkit-adapter.mjs");
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fontBytes = await readFile(path.join(
    path.dirname(require.resolve("dejavu-fonts-ttf/package.json")),
    "ttf",
    "DejaVuSans.ttf"
  ));
  const font = await document.embedFont(fontBytes, { subset: true });

  const page = document.addPage([300, 500]);
  page.drawText("Переведённый текст · 1 000 ₽ · ☑", {
    font,
    size: 14,
    x: 40,
    y: 430
  });

  const output = await document.save();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: output, disableWorker: true });

  try {
    const parsed = await loadingTask.promise;

    const parsedPage = await parsed.getPage(1);
    const content = await parsedPage.getTextContent();
    const item = content.items.find(({ str }) => str);
    const viewport = parsedPage.getViewport({ scale: 1 });
    const transform = pdfjs.Util.transform(viewport.transform, item.transform);
    assert.equal(item.str, "Переведённый текст · 1 000 ₽ · ☑");
    assert.ok(Math.abs(Math.sin(Math.atan2(transform[1], transform[0]))) < 0.01);
    assert.ok(Math.abs(transform[4] - 40) < 0.01);
    assert.ok(Math.abs(transform[5] - 70) < 0.01);
  } finally {
    await loadingTask.destroy();
  }
});
