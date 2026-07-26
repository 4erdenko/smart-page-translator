import * as pdfjsLib from "../vendor/pdf.mjs";

(function initializePdfWorkspace() {
  const api = globalThis.browser;
  const {
    PDFDocument,
    rgb
  } = globalThis.PDFLib;
  const fontkit = globalThis.fontkit;
  const {
    fillLanguageSelect,
    localizeDocument,
    t
  } = globalThis.SmartTranslationUiI18n;
  const {
    applyDocumentTranslationSegment,
    createDocumentTranslationSegments,
    createPdfTextBlocks,
    createTranslationBatches,
    getBoundedPdfRenderScale,
    getPdfTextMaskRectangle,
    getTranslatedPagePreviewMode,
    isSupportedPdfTextTransform,
    selectPdfBackgroundChannels
  } = globalThis.SmartTranslationDocumentCore;
  const EXPORT_SCALE = 2;
  const MAX_CANVAS_DIMENSION = 16_384;
  const MAX_DOCUMENT_CHARACTERS = 5_000_000;
  const MAX_EXPORT_IMAGE_BYTES = 128 * 1024 * 1024;
  const MAX_EXPORT_RENDER_PIXELS = 12_000_000;
  const MAX_PDF_BYTES = 100 * 1024 * 1024;
  const MAX_PDF_PAGES = 1000;
  const MAX_PREVIEW_RENDER_PIXELS = 4_000_000;
  const MIN_EXPORT_FONT_SIZE = 0.75;
  const PREVIEW_SCALE = Math.min(2, Math.max(1.25, Number(globalThis.devicePixelRatio) || 1));
  const elements = {
    cacheTranslations: document.querySelector("#cacheTranslations"),
    cancelButton: document.querySelector("#cancelButton"),
    chooseFileButton: document.querySelector("#chooseFileButton"),
    documentName: document.querySelector("#documentName"),
    documentSummary: document.querySelector("#documentSummary"),
    downloadButton: document.querySelector("#downloadButton"),
    dropZone: document.querySelector("#dropZone"),
    fileInput: document.querySelector("#fileInput"),
    intro: document.querySelector("#intro"),
    introStatus: document.querySelector("#introStatus"),
    pageTemplate: document.querySelector("#pageTemplate"),
    pages: document.querySelector("#pages"),
    progressBar: document.querySelector("#progressBar"),
    progressText: document.querySelector("#progressText"),
    removeButton: document.querySelector("#removeButton"),
    settingsButton: document.querySelector("#settingsButton"),
    targetLanguage: document.querySelector("#targetLanguage"),
    translationBadge: document.querySelector("#translationBadge"),
    translateButton: document.querySelector("#translateButton"),
    viewModeButtons: [...document.querySelectorAll("[data-view-mode]")],
    workspace: document.querySelector("#workspace")
  };
  let activePreviewRenders = 0;
  let activeRun;
  let busy = false;
  let documentState;
  let exportError = "";
  let hasApiKey = false;
  let pendingLoad;
  const pageViews = new Map();
  let pageViewObserver;
  const previewQueue = [];
  let providerLabel = "";
  let savedTargetLanguage = "";
  let settingsRefreshPending = false;
  localizeDocument();
  fillLanguageSelect(elements.targetLanguage);
  document.body.dataset.viewMode = "bilingual";
  pdfjsLib.GlobalWorkerOptions.workerSrc = api.runtime.getURL("vendor/pdf.worker.mjs");

  function formatNumber(value) {
    return new Intl.NumberFormat(api.i18n.getUILanguage()).format(Number(value) || 0);
  }

  function showProgress(message, completed = 0, total = 0) {
    elements.progressText.textContent = message;
    elements.progressBar.style.width = `${total > 0 ? Math.min(100, completed / total * 100) : 0}%`;
  }

  function isDocumentTranslated() {
    return documentState?.translationComplete === true;
  }

  function setBusy(nextBusy) {
    const wasBusy = busy;
    busy = nextBusy;
    const translated = isDocumentTranslated();
    elements.cacheTranslations.disabled = busy;
    elements.cancelButton.hidden = !busy || !activeRun;
    elements.chooseFileButton.disabled = busy;
    elements.downloadButton.disabled = busy || !translated;
    elements.downloadButton.hidden = !translated;
    elements.fileInput.disabled = busy;
    elements.removeButton.disabled = busy;
    elements.targetLanguage.disabled = busy;
    elements.translationBadge.hidden = !translated;
    elements.translateButton.disabled = busy || !documentState || !hasApiKey;
    elements.dropZone.disabled = busy;
    document.body.setAttribute("aria-busy", String(busy));

    if (wasBusy && !busy && settingsRefreshPending) {
      settingsRefreshPending = false;
      queueMicrotask(() => {
        void loadSettings().catch((error) => showProgress(String(error?.message || error)));
      });
    }
  }

  function clearCanvas(canvas) {
    delete canvas.dataset.rendered;
    canvas.width = 1;
    canvas.height = 1;
  }

  function releasePageView(view) {
    view.wanted = false;

    if (view.queued) {
      return;
    }

    clearCanvas(view.originalCanvas);
    clearCanvas(view.translatedCanvas);
    view.rendered = false;
  }

  function clearPageViews() {
    pageViewObserver?.disconnect();
    pageViewObserver = undefined;
    previewQueue.splice(0);

    for (const view of pageViews.values()) {
      releasePageView(view);
    }

    pageViews.clear();
    elements.pages.replaceChildren();
  }

  function disposeDocument(state) {
    if (!state || state.disposed) {
      return;
    }

    state.disposed = true;
    URL.revokeObjectURL(state.sourceUrl);
    void state.loadingTask.destroy().catch(() => undefined);
  }

  function disposePendingLoad(load = pendingLoad) {
    if (!load || load.disposed) {
      return Promise.resolve();
    }

    load.disposed = true;

    if (pendingLoad === load) {
      pendingLoad = undefined;
    }

    URL.revokeObjectURL(load.sourceUrl);
    return load.loadingTask.destroy().catch(() => undefined);
  }

  function clearDocument() {
    const previousState = documentState;
    documentState = undefined;
    exportError = "";
    void disposePendingLoad();
    clearPageViews();
    elements.workspace.hidden = true;
    elements.intro.hidden = false;
    setBusy(false);
    disposeDocument(previousState);
  }

  function getSafeScale(width, height, preferredScale, maximumPixels) {
    const scale = getBoundedPdfRenderScale(
      width,
      height,
      preferredScale,
      maximumPixels,
      MAX_CANVAS_DIMENSION
    );

    if (!scale) {
      throw new Error(t("invalidPdf", null, "Choose a valid PDF file."));
    }

    return scale;
  }

  function toPdfFragment(item, styles, viewport) {
    const text = typeof item?.str === "string" ? item.str.normalize("NFC").trim() : "";

    if (!text || !Array.isArray(item.transform)) {
      return null;
    }

    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const style = styles[item.fontName] || {};

    if (!isSupportedPdfTextTransform(transform, style.vertical)) {
      return null;
    }

    let angle = Math.atan2(transform[1], transform[0]);

    if (style.vertical) {
      angle += Math.PI / 2;
    }

    const fontHeight = Math.hypot(transform[2], transform[3]);
    const fontAscent = fontHeight * (
      Number.isFinite(style.ascent)
        ? style.ascent
        : Number.isFinite(style.descent)
          ? 1 + style.descent
          : 0.8
    );

    return {
      fontFamily: style.fontFamily || "sans-serif",
      height: Math.max(1, fontHeight),
      text,
      width: Math.max(1, Number(item.width || 0) * viewport.scale),
      x: transform[4] + fontAscent * Math.sin(angle),
      y: transform[5] - fontAscent * Math.cos(angle)
    };
  }

  function buildBlockContext(page, blockIndex, segmentIndex, segments) {
    const segmentCount = segments.length;
    const previous = segmentIndex > 0
      ? segments[segmentIndex - 1].text.slice(-120)
      : page.blocks[blockIndex - 1]?.text.slice(-120) || "";
    const next = segmentIndex < segmentCount - 1
      ? segments[segmentIndex + 1].text.slice(0, 120)
      : page.blocks[blockIndex + 1]?.text.slice(0, 120) || "";
    return [
      "PDF visual text block.",
      segmentCount > 1 ? `Segment ${segmentIndex + 1} of ${segmentCount}.` : "",
      previous ? `Previous context: ${previous}` : "",
      next ? `Next context: ${next}` : ""
    ].filter(Boolean).join(" ");
  }

  function buildDocumentItems() {
    return documentState.pages.flatMap((page) => page.blocks.flatMap((block, blockIndex) => {
      const segments = createDocumentTranslationSegments(block.id, block.text);
      block.translationSegments = segments.map(({ separator }) => ({
        separator,
        translation: ""
      }));

      return segments.map((segment) => ({
        blockIndex,
        context: buildBlockContext(page, blockIndex, segment.index, segments),
        id: segment.id,
        kind: "document",
        pageNumber: page.number,
        segmentCount: segment.count,
        segmentIndex: segment.index,
        text: segment.text
      }));
    }));
  }

  function translatedPageCount() {
    const documentTranslated = isDocumentTranslated();

    return documentState.pages.filter((page) => (
      page.blocks.length > 0
        ? page.blocks.every(({ translation }) => translation)
        : documentTranslated
    )).length;
  }

  function updateDocumentSummary() {
    elements.documentSummary.textContent = t(
      "pdfDocumentSummary",
      {
        characters: formatNumber(documentState.characters),
        pages: formatNumber(documentState.pages.length),
        translated: formatNumber(translatedPageCount())
      },
      `${formatNumber(documentState.pages.length)} pages · ${formatNumber(documentState.characters)} characters · ${formatNumber(translatedPageCount())} translated`
    );
    setBusy(busy);
  }

  function clearTranslations() {
    if (!documentState) {
      return;
    }

    exportError = "";
    documentState.translationComplete = false;

    for (const page of documentState.pages) {
      for (const block of page.blocks) {
        block.translation = "";
        delete block.translationSegments;
      }

      refreshTranslatedPreview(page, false);
    }

    updateDocumentSummary();
  }

  function samplePixel(context, x, y) {
    const pixelX = Math.max(0, Math.min(context.canvas.width - 1, Math.round(x)));
    const pixelY = Math.max(0, Math.min(context.canvas.height - 1, Math.round(y)));
    return [...context.getImageData(pixelX, pixelY, 1, 1).data];
  }

  function sampleBackgroundColor(context, block, scale) {
    const x = block.x * scale;
    const y = block.y * scale;
    const width = block.width * scale;
    const height = block.height * scale;
    const offset = Math.max(3, block.fontSize * scale * 0.3);
    const samples = [
      samplePixel(context, x - offset, y + height * 0.2),
      samplePixel(context, x - offset, y + height * 0.5),
      samplePixel(context, x - offset, y + height * 0.8),
      samplePixel(context, x + width + offset, y + height * 0.2),
      samplePixel(context, x + width + offset, y + height * 0.5),
      samplePixel(context, x + width + offset, y + height * 0.8),
      samplePixel(context, x + width * 0.2, y - offset),
      samplePixel(context, x + width * 0.5, y - offset),
      samplePixel(context, x + width * 0.8, y - offset),
      samplePixel(context, x + width * 0.2, y + height + offset),
      samplePixel(context, x + width * 0.5, y + height + offset),
      samplePixel(context, x + width * 0.8, y + height + offset)
    ];
    const channels = selectPdfBackgroundChannels(samples);

    return {
      channels,
      css: `rgb(${channels.join(" ")})`,
      dark: channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 112
    };
  }

  function splitLongToken(context, token, maximumWidth) {
    const parts = [];
    let part = "";

    for (const character of Array.from(token)) {
      const candidate = `${part}${character}`;

      if (part && context.measureText(candidate).width > maximumWidth) {
        parts.push(part);
        part = character;
      } else {
        part = candidate;
      }
    }

    if (part) {
      parts.push(part);
    }

    return parts;
  }

  function wrapCanvasText(context, text, maximumWidth) {
    const paragraphs = String(text || "").split(/\n+/u);
    const lines = [];

    for (const paragraph of paragraphs) {
      const words = paragraph.trim().split(/\s+/u).filter(Boolean);
      let line = "";

      for (const word of words) {
        const parts = context.measureText(word).width > maximumWidth
          ? splitLongToken(context, word, maximumWidth)
          : [word];

        for (const part of parts) {
          const candidate = line ? `${line} ${part}` : part;

          if (line && context.measureText(candidate).width > maximumWidth) {
            lines.push(line);
            line = part;
          } else {
            line = candidate;
          }
        }
      }

      if (line) {
        lines.push(line);
      }
    }

    return lines;
  }

  function fitCanvasText(context, block, scale) {
    const maximumWidth = Math.max(1, block.width * scale);
    const maximumHeight = Math.max(block.fontSize * 1.05, block.height) * scale;
    const minimumFontSize = Math.max(3.25 * scale, block.fontSize * scale * 0.38);
    const preferredFontSize = Math.max(minimumFontSize, block.fontSize * scale);
    let fontSize = preferredFontSize;
    let lines;
    let lineHeight;

    while (true) {
      context.font = `${block.fontWeight} ${fontSize}px ${block.fontFamily}, sans-serif`;
      lines = wrapCanvasText(context, block.translation, maximumWidth);
      lineHeight = fontSize * 1.12;

      if (lines.length * lineHeight <= maximumHeight + fontSize * 0.12
        || fontSize === minimumFontSize) {
        break;
      }

      fontSize = Math.max(minimumFontSize, fontSize - Math.max(0.35 * scale, 0.5));
    }

    return { fontSize, lineHeight, lines, maximumHeight, maximumWidth };
  }

  function isRtlText(value) {
    return /[\u0590-\u08ff]/u.test(String(value || ""));
  }

  function drawTranslationBlock(
    context,
    sourceContext,
    block,
    scale,
    { background: providedBackground, drawText = true } = {}
  ) {
    if (!block.translation) {
      return null;
    }

    const background = providedBackground || sampleBackgroundColor(sourceContext, block, scale);
    const textPadding = Math.max(1, block.fontSize * scale * 0.08);
    context.save();

    for (const line of block.lines) {
      const rectangle = getPdfTextMaskRectangle(
        line,
        scale,
        context.canvas.width,
        context.canvas.height
      );
      context.fillStyle = background.css;
      context.fillRect(
        rectangle.x,
        rectangle.y,
        rectangle.width,
        rectangle.height
      );
    }

    if (!drawText) {
      context.restore();
      return background;
    }

    const layout = fitCanvasText(context, block, scale);
    const rtl = isRtlText(block.translation);
    const startX = block.alignment === "center"
      ? (block.x + block.width / 2) * scale
      : rtl
        ? (block.x + block.width) * scale
        : block.x * scale;
    const startY = block.y * scale;
    context.beginPath();
    context.rect(
      Math.max(0, block.x * scale - textPadding),
      Math.max(0, block.y * scale - textPadding),
      layout.maximumWidth + textPadding * 2,
      layout.maximumHeight + textPadding * 2
    );
    context.clip();
    context.direction = rtl ? "rtl" : "ltr";
    context.fillStyle = background.dark ? "#fff" : "#111";
    context.font = `${block.fontWeight} ${layout.fontSize}px ${block.fontFamily}, sans-serif`;
    context.textAlign = block.alignment === "center" ? "center" : rtl ? "right" : "left";
    context.textBaseline = "top";

    layout.lines.forEach((line, index) => {
      context.fillText(line, startX, startY + index * layout.lineHeight);
    });
    context.restore();
    return background;
  }

  function drawTranslationOverlay(
    page,
    context,
    sourceContext,
    scale,
    { backgrounds = new Map(), drawText = true } = {}
  ) {

    for (const block of page.blocks) {
      const background = drawTranslationBlock(
        context,
        sourceContext,
        block,
        scale,
        {
          background: backgrounds.get(block.id),
          drawText
        }
      );

      if (background) {
        backgrounds.set(block.id, background);
      }
    }

    return backgrounds;
  }

  function refreshTranslatedPreview(page, documentTranslated = false) {
    const view = pageViews.get(page.number);

    if (!view?.rendered) {
      return;
    }

    const context = view.translatedCanvas.getContext("2d", { alpha: false });
    const sourceContext = view.originalCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    const previewMode = getTranslatedPagePreviewMode(page.blocks, documentTranslated);
    view.translationEmpty.hidden = previewMode !== "pending";

    if (previewMode === "original") {
      context.drawImage(view.originalCanvas, 0, 0);
      return;
    }

    if (previewMode === "pending") {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, context.canvas.width, context.canvas.height);
      return;
    }

    context.drawImage(view.originalCanvas, 0, 0);
    drawTranslationOverlay(page, context, sourceContext, view.scale);
  }

  async function renderPagePreview(page, view, state) {
    const pdfPage = await state.pdfDocument.getPage(page.number);
    try {
      const scale = getSafeScale(
        page.width,
        page.height,
        PREVIEW_SCALE,
        MAX_PREVIEW_RENDER_PIXELS
      );
      const viewport = pdfPage.getViewport({ scale });

      for (const canvas of [view.originalCanvas, view.translatedCanvas]) {
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
      }

      const originalContext = view.originalCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true
      });
      await pdfPage.render({
        background: "#fff",
        canvas: view.originalCanvas,
        canvasContext: originalContext,
        viewport
      }).promise;

      if (documentState !== state || pageViews.get(page.number) !== view || !view.wanted) {
        clearCanvas(view.originalCanvas);
        clearCanvas(view.translatedCanvas);
        return;
      }

      view.scale = scale;
      view.rendered = true;
      view.originalCanvas.dataset.rendered = "true";
      view.translatedCanvas.dataset.rendered = "true";
      refreshTranslatedPreview(
        page,
        page.blocks.length === 0 && state.translationComplete
      );
    } finally {
      pdfPage.cleanup();
    }
  }

  function drainPreviewQueue() {
    while (activePreviewRenders < 2 && previewQueue.length > 0) {
      const queued = previewQueue.shift();

      if (!queued.view.wanted || queued.view.rendered || documentState !== queued.state) {
        queued.view.queued = false;
        continue;
      }

      activePreviewRenders += 1;
      void renderPagePreview(queued.page, queued.view, queued.state)
        .catch((error) => {
          if (!queued.view.rendered) {
            clearCanvas(queued.view.originalCanvas);
            clearCanvas(queued.view.translatedCanvas);
          }

          if (documentState === queued.state && queued.view.wanted) {
            showProgress(String(error?.message || error));
          }
        })
        .finally(() => {
          queued.view.queued = false;
          activePreviewRenders -= 1;
          drainPreviewQueue();
        });
    }
  }

  function queuePagePreview(page, view) {
    view.wanted = true;

    if (view.rendered || view.queued) {
      return;
    }

    view.queued = true;
    previewQueue.push({ page, state: documentState, view });
    drainPreviewQueue();
  }

  function renderPages() {
    clearPageViews();
    pageViewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber);
        const page = documentState?.pages[pageNumber - 1];
        const view = pageViews.get(pageNumber);

        if (!page || !view) {
          continue;
        }

        if (entry.isIntersecting) {
          queuePagePreview(page, view);
        } else {
          releasePageView(view);
        }
      }
    }, { rootMargin: "900px 0px", threshold: 0 });

    for (const page of documentState.pages) {
      const fragment = elements.pageTemplate.content.cloneNode(true);
      localizeDocument(fragment);
      const article = fragment.querySelector(".page-sheet");
      const originalCanvas = fragment.querySelector(".page-original canvas");
      const translatedCanvas = fragment.querySelector(".page-translation canvas");
      const translationEmpty = fragment.querySelector(".translation-empty");

      if (page.blocks.length === 0) {
        translationEmpty.querySelector("strong").textContent = t(
          "pdfPageNoTextTitle",
          null,
          "No translatable text on this page"
        );
        translationEmpty.querySelector("span").textContent = t(
          "pdfPageNoTextDetails",
          null,
          "The original page will be preserved in the translated download."
        );
      }

      article.dataset.pageNumber = String(page.number);
      article.style.setProperty("--page-ratio", `${page.width} / ${page.height}`);
      fragment.querySelector(".page-number").textContent = t(
        "pdfPageNumber",
        { number: page.number },
        `Page ${page.number}`
      );
      const view = {
        article,
        originalCanvas,
        queued: false,
        rendered: false,
        scale: PREVIEW_SCALE,
        translationEmpty,
        translatedCanvas,
        wanted: false
      };
      pageViews.set(page.number, view);
      elements.pages.append(fragment);
      pageViewObserver.observe(article);
    }
  }

  async function parsePdf(file) {
    const isPdf = file instanceof File
      && (file.type === "application/pdf" || /\.pdf$/iu.test(file.name));

    if (!isPdf || file.size > MAX_PDF_BYTES) {
      throw new Error(t("invalidPdf", null, "Choose a PDF file up to 100 MiB."));
    }

    setBusy(true);
    exportError = "";
    const previousState = documentState;
    documentState = undefined;
    await disposePendingLoad();
    clearPageViews();
    disposeDocument(previousState);
    showProgress(t("readingPdf", null, "Reading PDF locally…"));
    const sourceUrl = URL.createObjectURL(file);
    const loadingTask = pdfjsLib.getDocument({
      cMapPacked: true,
      cMapUrl: api.runtime.getURL("vendor/cmaps/"),
      isEvalSupported: false,
      standardFontDataUrl: api.runtime.getURL("vendor/standard_fonts/"),
      url: sourceUrl,
      wasmUrl: api.runtime.getURL("vendor/wasm/")
    });
    const load = {
      disposed: false,
      loadingTask,
      sourceUrl
    };
    pendingLoad = load;
    let pdfDocument;

    try {
      pdfDocument = await loadingTask.promise;

      if (pendingLoad !== load) {
        return;
      }

      if (pdfDocument.numPages > MAX_PDF_PAGES) {
        throw new Error(t("pdfTooManyPages", null, "This PDF has more than 1,000 pages."));
      }

      const pages = [];
      let characters = 0;

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        showProgress(
          t(
            "readingPdfPage",
            { current: pageNumber, total: pdfDocument.numPages },
            `Reading page ${pageNumber} of ${pdfDocument.numPages}…`
          ),
          pageNumber - 1,
          pdfDocument.numPages
        );
        const pdfPage = await pdfDocument.getPage(pageNumber);
        try {
          const viewport = pdfPage.getViewport({ scale: 1 });
          const content = await pdfPage.getTextContent();

          if (pendingLoad !== load) {
            return;
          }

          const fragments = content.items
            .map((item) => toPdfFragment(item, content.styles, viewport))
            .filter(Boolean);
          const blocks = createPdfTextBlocks(fragments, viewport.width).map((block, blockIndex) => ({
            ...block,
            id: `p${pageNumber}b${blockIndex}`,
            translation: ""
          }));
          characters += blocks.reduce((total, block) => total + block.text.length, 0);

          if (characters > MAX_DOCUMENT_CHARACTERS) {
            throw new Error(
              t(
                "pdfTooMuchText",
                null,
                "This PDF contains more than 5,000,000 extracted characters."
              )
            );
          }

          pages.push({
            blocks,
            height: viewport.height,
            number: pageNumber,
            width: viewport.width
          });
        } finally {
          pdfPage.cleanup();
        }
      }

      if (pendingLoad !== load) {
        return;
      }

      pendingLoad = undefined;
      documentState = {
        characters,
        disposed: false,
        file,
        loadingTask,
        name: file.name,
        pages,
        pdfDocument,
        sourceUrl,
        translationComplete: false
      };
    } catch (error) {
      const isCurrentLoad = pendingLoad === load;
      await disposePendingLoad(load);

      if (!isCurrentLoad) {
        return;
      }

      throw error;
    }

    elements.documentName.textContent = documentState.name;
    elements.intro.hidden = true;
    elements.workspace.hidden = false;
    renderPages();
    updateDocumentSummary();
    setBusy(false);
    showProgress(hasApiKey
      ? t("pdfReady", null, "PDF ready. Translation starts only when you request it.")
      : t(
        "apiKeyRequiredDetails",
        { provider: providerLabel },
        `Open Settings and configure a ${providerLabel} API key.`
      ));
  }

  function applyBatchTranslations(batch, response) {
    const translations = new Map(response.translations?.map(({ id, text }) => [id, text]));
    const changedPages = new Set();

    for (const item of batch) {
      const translated = translations.get(item.id);

      if (typeof translated !== "string") {
        throw new Error("The translation response did not include every PDF text block.");
      }

      const page = documentState.pages[item.pageNumber - 1];
      const block = page?.blocks[item.blockIndex];

      if (applyDocumentTranslationSegment(
        block,
        item.segmentIndex,
        item.segmentCount,
        translated
      )) {
        changedPages.add(page);
      }
    }

    for (const page of changedPages) {
      refreshTranslatedPreview(page, false);
    }
  }

  async function translateDocument() {
    clearTranslations();
    const items = buildDocumentItems();

    if (items.length === 0) {
      showProgress(t("pdfNoText", null, "No translatable text was found in this PDF."));
      return;
    }

    const batches = createTranslationBatches(items);
    const run = {
      cancelled: false,
      cancelledByUser: false,
      completed: 0,
      cursor: 0
    };
    activeRun = run;
    setBusy(true);
    showProgress(
      t("translatingPdf", { current: 0, total: batches.length }, `Translating 0 of ${batches.length} batches…`),
      0,
      batches.length
    );

    const worker = async () => {
      while (!run.cancelled && run.cursor < batches.length) {
        const batchIndex = run.cursor;
        run.cursor += 1;
        const batch = batches[batchIndex];

        try {
          const response = await api.runtime.sendMessage({
            items: batch.map(({ context, id, kind, text }) => ({ context, id, kind, text })),
            persistCache: elements.cacheTranslations.checked,
            sourceLanguage: "auto",
            type: "translateBatch"
          });

          if (run.cancelled || activeRun !== run) {
            return;
          }

          applyBatchTranslations(batch, response);
          run.completed += 1;
          updateDocumentSummary();
          showProgress(
            t(
              "translatingPdf",
              { current: run.completed, total: batches.length },
              `Translating ${run.completed} of ${batches.length} batches…`
            ),
            run.completed,
            batches.length
          );
        } catch (error) {
          if (!run.cancelledByUser) {
            run.error ||= error;
          }

          run.cancelled = true;
          await api.runtime.sendMessage({ type: "cancelTranslations" }).catch(() => undefined);
        }
      }
    };

    await Promise.all([worker(), worker()]);

    if (run.cancelledByUser) {
      showProgress(t("translationCancelled", null, "Translation cancelled."));
    } else if (run.error) {
      showProgress(String(run.error?.message || run.error));
    } else if (!run.cancelled) {
      documentState.translationComplete = true;
      const documentTranslated = isDocumentTranslated();
      updateDocumentSummary();

      for (const page of documentState.pages) {
        refreshTranslatedPreview(page, documentTranslated);
      }

      showProgress(
        t("pdfTranslated", null, "Translated PDF is ready to review or download."),
        batches.length,
        batches.length
      );
    }

    if (activeRun === run) {
      activeRun = undefined;
      setBusy(false);
    }
  }

  function translatedFileName() {
    const baseName = documentState.name.replace(/\.pdf$/iu, "") || "document";
    return `${baseName}-${elements.targetLanguage.value}.pdf`;
  }

  async function renderPdfPage(pdfPage, canvas, preferredScale) {
    const unitViewport = pdfPage.getViewport({ scale: 1 });
    const scale = getSafeScale(
      unitViewport.width,
      unitViewport.height,
      preferredScale,
      MAX_EXPORT_RENDER_PIXELS
    );
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    await pdfPage.render({
      background: "#fff",
      canvas,
      canvasContext: context,
      viewport
    }).promise;
    return { context, scale };
  }

  function splitLongPdfToken(font, token, fontSize, maximumWidth) {
    const parts = [];
    let part = "";

    for (const character of Array.from(token)) {
      const candidate = `${part}${character}`;

      if (part && font.widthOfTextAtSize(candidate, fontSize) > maximumWidth) {
        parts.push(part);
        part = character;
      } else {
        part = candidate;
      }
    }

    if (part) {
      parts.push(part);
    }

    return parts;
  }

  function wrapPdfText(font, text, fontSize, maximumWidth) {
    const paragraphs = String(text || "").split(/\n+/u);
    const lines = [];

    for (const paragraph of paragraphs) {
      const words = paragraph.trim().split(/\s+/u).filter(Boolean);
      let line = "";

      for (const word of words) {
        const parts = font.widthOfTextAtSize(word, fontSize) > maximumWidth
          ? splitLongPdfToken(font, word, fontSize, maximumWidth)
          : [word];

        for (const part of parts) {
          const candidate = line ? `${line} ${part}` : part;

          if (line && font.widthOfTextAtSize(candidate, fontSize) > maximumWidth) {
            lines.push(line);
            line = part;
          } else {
            line = candidate;
          }
        }
      }

      if (line) {
        lines.push(line);
      }
    }

    return lines;
  }

  function fitPdfText(font, block) {
    const maximumWidth = Math.max(1, block.width);
    const maximumHeight = Math.max(block.fontSize * 1.05, block.height);
    let fontSize = Math.max(MIN_EXPORT_FONT_SIZE, block.fontSize);
    let lines;
    let lineHeight;

    while (true) {
      lines = wrapPdfText(font, block.translation, fontSize, maximumWidth);
      lineHeight = fontSize * 1.12;

      if (lines.length * lineHeight <= maximumHeight + fontSize * 0.12) {
        break;
      }

      if (fontSize <= MIN_EXPORT_FONT_SIZE) {
        throw new Error(
          t(
            "pdfTranslationDoesNotFit",
            null,
            "A translated text block does not fit its PDF region. Review the document layout."
          )
        );
      }

      fontSize = Math.max(MIN_EXPORT_FONT_SIZE, fontSize - 0.4);
    }

    return { fontSize, lineHeight, lines };
  }

  function drawPdfTranslationBlock(outputPage, block, font, background) {
    const layout = fitPdfText(font, block);
    const textColor = background.dark ? rgb(1, 1, 1) : rgb(0.067, 0.067, 0.067);

    layout.lines.forEach((line, index) => {
      const lineWidth = font.widthOfTextAtSize(line, layout.fontSize);
      const startX = block.alignment === "center"
        ? block.x + Math.max(0, (block.width - lineWidth) / 2)
        : isRtlText(block.translation)
          ? block.x + Math.max(0, block.width - lineWidth)
          : block.x;
      const baselineY = block.y + layout.fontSize * 0.82 + index * layout.lineHeight;
      outputPage.drawText(line, {
        color: textColor,
        font,
        size: layout.fontSize,
        x: startX,
        y: outputPage.getHeight() - baselineY
      });
    });
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Could not render the translated PDF page."));
          return;
        }

        void blob.arrayBuffer().then(resolve, reject);
      }, "image/png");
    });
  }

  async function fetchExtensionAsset(relativePath) {
    const response = await fetch(api.runtime.getURL(relativePath));

    if (!response.ok) {
      throw new Error(`Could not load the bundled PDF export asset: ${relativePath}`);
    }

    return response.arrayBuffer();
  }

  async function loadPdfExportFonts(outputDocument) {
    if (!fontkit) {
      throw new Error("The bundled PDF font engine is unavailable.");
    }

    outputDocument.registerFontkit(fontkit);
    const [regularBytes, boldBytes] = await Promise.all([
      fetchExtensionAsset("vendor/export_fonts/DejaVuSans.ttf"),
      fetchExtensionAsset("vendor/export_fonts/DejaVuSans-Bold.ttf")
    ]);
    const [regular, bold] = await Promise.all([
      outputDocument.embedFont(regularBytes, { subset: true }),
      outputDocument.embedFont(boldBytes, { subset: true })
    ]);

    return { bold, regular };
  }

  function findUnsupportedPdfExportCharacter(text, supportedCodePoints) {
    for (const character of Array.from(String(text || ""))) {
      if (!/\s/u.test(character) && !supportedCodePoints.has(character.codePointAt(0))) {
        return character;
      }
    }

    return "";
  }

  function assertPdfExportGlyphCoverage(pages, exportFonts) {
    const coverage = {
      bold: new Set(exportFonts.bold.getCharacterSet()),
      regular: new Set(exportFonts.regular.getCharacterSet())
    };

    for (const page of pages) {
      for (const block of page.blocks) {
        const supportedCodePoints = block.fontWeight >= 600 ? coverage.bold : coverage.regular;

        if (findUnsupportedPdfExportCharacter(block.translation, supportedCodePoints)) {
          throw new Error(
            t(
              "pdfUnsupportedExportCharacters",
              null,
              "This translation contains characters the bundled PDF font cannot render. Export was stopped to avoid missing text."
            )
          );
        }
      }
    }
  }

  async function downloadTranslatedPdf() {
    if (!isDocumentTranslated()) {
      return;
    }

    exportError = "";
    setBusy(true);
    showProgress(
      t("exportingPdf", { current: 0, total: documentState.pages.length }, `Building PDF 0 of ${documentState.pages.length}…`),
      0,
      documentState.pages.length
    );

    try {
      const outputDocument = await PDFDocument.create();
      const exportFonts = await loadPdfExportFonts(outputDocument);
      assertPdfExportGlyphCoverage(documentState.pages, exportFonts);
      let embeddedImageBytes = 0;

      for (const page of documentState.pages) {
        let pdfPage;
        const sourceCanvas = document.createElement("canvas");

        try {
          pdfPage = await documentState.pdfDocument.getPage(page.number);
          const { context: sourceContext, scale } = await renderPdfPage(
            pdfPage,
            sourceCanvas,
            EXPORT_SCALE
          );
          const backgrounds = new Map(page.blocks
            .filter(({ translation }) => translation)
            .map((block) => [
              block.id,
              sampleBackgroundColor(sourceContext, block, scale)
            ]));
          drawTranslationOverlay(
            page,
            sourceContext,
            sourceContext,
            scale,
            { backgrounds, drawText: false }
          );
          const pageImageBytes = await canvasToPngBytes(sourceCanvas);
          embeddedImageBytes += pageImageBytes.byteLength;

          if (embeddedImageBytes > MAX_EXPORT_IMAGE_BYTES) {
            throw new Error(
              t(
                "pdfExportTooLarge",
                null,
                "The flattened PDF exceeds the safe 128 MiB export limit. Split the document and try again."
              )
            );
          }

          const pageImage = await outputDocument.embedPng(pageImageBytes);
          const outputPage = outputDocument.addPage([page.width, page.height]);
          outputPage.drawImage(pageImage, {
            height: page.height,
            width: page.width,
            x: 0,
            y: 0
          });

          for (const block of page.blocks) {
            drawPdfTranslationBlock(
              outputPage,
              block,
              block.fontWeight >= 600 ? exportFonts.bold : exportFonts.regular,
              backgrounds.get(block.id)
            );
          }
        } finally {
          clearCanvas(sourceCanvas);
          pdfPage?.cleanup();
        }

        showProgress(
          t(
            "exportingPdf",
            { current: page.number, total: documentState.pages.length },
            `Building PDF ${page.number} of ${documentState.pages.length}…`
          ),
          page.number,
          documentState.pages.length
        );
      }

      const outputBytes = await outputDocument.save();
      const downloadUrl = URL.createObjectURL(new Blob([outputBytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.download = translatedFileName();
      link.href = downloadUrl;
      link.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      showProgress(t("pdfDownloadReady", null, "Translated PDF download started."));
    } catch (error) {
      exportError = String(error?.message || error);
      showProgress(exportError);
    } finally {
      setBusy(false);
    }
  }

  async function loadSettings() {
    const response = await api.runtime.sendMessage({ type: "getSettings" });

    if (busy) {
      settingsRefreshPending = true;
      return;
    }

    const nextTargetLanguage = response.settings.targetLanguage;

    if (savedTargetLanguage && savedTargetLanguage !== nextTargetLanguage) {
      clearTranslations();
    }

    savedTargetLanguage = nextTargetLanguage;
    elements.targetLanguage.value = nextTargetLanguage;
    hasApiKey = response.hasApiKey;
    providerLabel = response.providers?.[response.settings.provider]?.label || response.settings.provider;

    if (exportError) {
      showProgress(exportError);
    } else if (isDocumentTranslated()) {
      showProgress(t("pdfTranslated", null, "Translated PDF is ready to review or download."));
    } else if (!hasApiKey) {
      showProgress(
        t(
          "apiKeyRequiredDetails",
          { provider: providerLabel },
          "Open Settings and configure a provider API key."
        )
      );
    } else if (documentState) {
      showProgress(t("pdfReady", null, "PDF ready. Translation starts only when you request it."));
    }

    setBusy(busy);
  }

  function handleFile(file) {
    if (busy) {
      return;
    }

    elements.introStatus.textContent = "";
    void parsePdf(file).catch((error) => {
      clearDocument();
      elements.introStatus.textContent = String(error?.message || error);
      setBusy(false);
    });
  }

  elements.fileInput.addEventListener("change", () => {
    const [file] = elements.fileInput.files;

    if (file) {
      handleFile(file);
    }

    elements.fileInput.value = "";
  });
  elements.chooseFileButton.addEventListener("click", () => elements.fileInput.click());
  elements.dropZone.addEventListener("click", () => elements.fileInput.click());
  elements.dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    elements.dropZone.dataset.active = "true";
  });
  elements.dropZone.addEventListener("dragover", (event) => event.preventDefault());
  elements.dropZone.addEventListener("dragleave", () => {
    delete elements.dropZone.dataset.active;
  });
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    delete elements.dropZone.dataset.active;
    const [file] = event.dataTransfer.files;

    if (file) {
      handleFile(file);
    }
  });
  elements.targetLanguage.addEventListener("change", async () => {
    const previousTargetLanguage = savedTargetLanguage;
    setBusy(true);

    try {
      await api.runtime.sendMessage({
        settings: { targetLanguage: elements.targetLanguage.value },
        type: "updateSettings"
      });
      savedTargetLanguage = elements.targetLanguage.value;
      clearTranslations();
      showProgress(t("pdfReady", null, "PDF ready. Translation starts only when you request it."));
    } catch (error) {
      elements.targetLanguage.value = previousTargetLanguage;
      showProgress(String(error?.message || error));
    } finally {
      setBusy(false);
    }
  });
  elements.translateButton.addEventListener("click", () => void translateDocument());
  elements.downloadButton.addEventListener("click", () => void downloadTranslatedPdf());
  elements.cancelButton.addEventListener("click", () => {
    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.cancelledByUser = true;
      void api.runtime.sendMessage({ type: "cancelTranslations" }).catch(() => undefined);
      showProgress(t("translationCancelled", null, "Translation cancelled."));
    }
  });
  elements.removeButton.addEventListener("click", () => {
    clearDocument();
    showProgress("");
  });
  elements.settingsButton.addEventListener("click", () => api.runtime.openOptionsPage());

  for (const button of elements.viewModeButtons) {
    button.addEventListener("click", () => {
      document.body.dataset.viewMode = button.dataset.viewMode;

      for (const viewButton of elements.viewModeButtons) {
        viewButton.setAttribute(
          "aria-pressed",
          String(viewButton.dataset.viewMode === button.dataset.viewMode)
        );
      }
    });
  }

  elements.viewModeButtons.find(({ dataset }) => dataset.viewMode === "bilingual")
    ?.setAttribute("aria-pressed", "true");
  window.addEventListener("pagehide", () => {
    if (activeRun) {
      activeRun.cancelled = true;
      void api.runtime.sendMessage({ type: "cancelTranslations" }).catch(() => undefined);
    }

    void disposePendingLoad();
    disposeDocument(documentState);
    clearPageViews();
  });
  window.addEventListener("focus", () => {
    if (!busy) {
      void loadSettings().catch((error) => showProgress(String(error?.message || error)));
    }
  });

  loadSettings().catch((error) => showProgress(String(error?.message || error)));
})();
