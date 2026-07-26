(function initializeDocumentCore(root, factory) {
  const api = factory();
  root.SmartTranslationDocumentCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createDocumentCore() {
  function normalizePdfFragment(fragment, index) {
    const text = typeof fragment?.text === "string"
      ? fragment.text.normalize("NFC").trim()
      : "";
    const x = Number(fragment?.x);
    const y = Number(fragment?.y);
    const width = Number(fragment?.width);
    const height = Number(fragment?.height);

    if (!text
      || !Number.isFinite(x)
      || !Number.isFinite(y)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || width < 0
      || height <= 0) {
      return null;
    }

    return {
      fontFamily: String(fragment?.fontFamily || "sans-serif"),
      height,
      index,
      text,
      width,
      x,
      y
    };
  }

  function joinPdfFragments(fragments) {
    let text = "";
    let previous;

    for (const fragment of fragments) {
      const gap = previous ? fragment.x - (previous.x + previous.width) : 0;
      const shouldAddSpace = previous
        && gap > Math.max(0.75, Math.min(previous.height, fragment.height) * 0.08)
        && !/[\s\u00a0/-]$/u.test(text)
        && !/^[,.;:!?%)\]}]/u.test(fragment.text);

      if (shouldAddSpace) {
        text += " ";
      }

      text += fragment.text;
      previous = fragment;
    }

    return text.replace(/[\s\u00a0]+/gu, " ").trim();
  }

  function splitPdfRow(fragments, pageWidth) {
    const rows = [];
    let row = [];
    let previous;

    for (const fragment of fragments) {
      const gap = previous ? fragment.x - (previous.x + previous.width) : 0;
      const columnGap = Math.max(
        18,
        Math.min(previous?.height || fragment.height, fragment.height) * 2.5,
        pageWidth * 0.035
      );

      if (row.length > 0 && gap > columnGap) {
        rows.push(row);
        row = [];
      }

      row.push(fragment);
      previous = fragment;
    }

    if (row.length > 0) {
      rows.push(row);
    }

    return rows;
  }

  function createPdfLines(fragments, pageWidth) {
    const alignedRows = [];
    const ordered = fragments
      .map(normalizePdfFragment)
      .filter(Boolean)
      .sort((left, right) => left.y - right.y || left.x - right.x || left.index - right.index);

    for (const fragment of ordered) {
      const center = fragment.y + fragment.height / 2;
      const line = alignedRows.findLast((candidate) => (
        Math.abs(center - candidate.center)
          <= Math.max(2, Math.min(fragment.height, candidate.height) * 0.45)
      ));

      if (line) {
        line.fragments.push(fragment);
        line.center = (line.center * (line.fragments.length - 1) + center) / line.fragments.length;
        line.height = Math.max(line.height, fragment.height);
      } else {
        alignedRows.push({
          center,
          fragments: [fragment],
          height: fragment.height
        });
      }
    }

    return alignedRows
      .flatMap((line) => splitPdfRow(
        line.fragments.sort((left, right) => left.x - right.x || left.index - right.index),
        pageWidth
      ))
      .map((lineFragments) => {
        const x = Math.min(...lineFragments.map((fragment) => fragment.x));
        const y = Math.min(...lineFragments.map((fragment) => fragment.y));
        const right = Math.max(...lineFragments.map((fragment) => fragment.x + fragment.width));
        const bottom = Math.max(...lineFragments.map((fragment) => fragment.y + fragment.height));
        const fontFamilies = new Map();

        for (const fragment of lineFragments) {
          fontFamilies.set(
            fragment.fontFamily,
            Number(fontFamilies.get(fragment.fontFamily) || 0) + 1
          );
        }

        return {
          fontFamily: [...fontFamilies]
            .sort((left, right) => right[1] - left[1])[0]?.[0] || "sans-serif",
          fontSize: Math.max(...lineFragments.map((fragment) => fragment.height)),
          height: bottom - y,
          text: joinPdfFragments(lineFragments),
          width: right - x,
          x,
          y
        };
      })
      .filter(({ text }) => text)
      .sort((left, right) => left.y - right.y || left.x - right.x);
  }

  function startsFieldLabel(value) {
    return /^[\p{L}][\p{L}\p{M}\s./()-]{0,32}:\s*\S/u.test(String(value || ""));
  }

  function shouldMergePdfLine(block, line, pageWidth) {
    const previous = block.lines.at(-1);
    const verticalGap = line.y - (previous.y + previous.height);
    const lineHeight = Math.max(previous.fontSize, line.fontSize, 1);
    const overlap = Math.max(
      0,
      Math.min(previous.x + previous.width, line.x + line.width) - Math.max(previous.x, line.x)
    );
    const sameColumn = Math.abs(previous.x - line.x) <= Math.max(18, lineHeight * 2)
      || overlap / Math.max(1, Math.min(previous.width, line.width)) >= 0.55;
    const previousText = previous.text.trim();
    const nextText = line.text.trim();

    if (!sameColumn
      || verticalGap < -lineHeight * 0.5
      || verticalGap > Math.max(10, lineHeight * 1.35)
      || /^[•▪◦●·*-]\s/u.test(nextText)
      || (startsFieldLabel(previousText) && startsFieldLabel(nextText))) {
      return false;
    }

    if (/[-‐‑‒–—]$/u.test(previousText)) {
      return true;
    }

    if (/[.!?;:]\s*["')\]}]*$/u.test(previousText)) {
      return false;
    }

    const occupiesTextColumn = previous.width >= pageWidth * 0.45
      || line.width >= pageWidth * 0.45;
    return occupiesTextColumn || block.lines.length <= 2;
  }

  function finalizePdfBlock(lines, pageWidth) {
    const x = Math.min(...lines.map((line) => line.x));
    const y = Math.min(...lines.map((line) => line.y));
    const right = Math.max(...lines.map((line) => line.x + line.width));
    const bottom = Math.max(...lines.map((line) => line.y + line.height));
    const text = lines.reduce((value, line) => {
      if (!value) {
        return line.text;
      }

      return /[-‐‑‒–—]$/u.test(value)
        ? `${value.slice(0, -1)}${line.text}`
        : `${value} ${line.text}`;
    }, "").replace(/[\s\u00a0]+/gu, " ").trim();
    const letters = text.match(/\p{L}/gu) || [];
    const uppercase = text.match(/\p{Lu}/gu) || [];
    const centered = x > pageWidth * 0.17
      && letters.length > 0
      && uppercase.length / letters.length >= 0.65
      && right - x < pageWidth * 0.8;

    return {
      alignment: centered ? "center" : "left",
      fontFamily: lines[0].fontFamily,
      fontSize: Math.max(...lines.map((line) => line.fontSize)),
      fontWeight: uppercase.length / Math.max(1, letters.length) >= 0.65 && text.length <= 160
        ? 700
        : 400,
      height: bottom - y,
      lines,
      text,
      width: right - x,
      x,
      y
    };
  }

  function createPdfTextBlocks(fragments, pageWidth) {
    const blocks = [];
    const normalizedPageWidth = Number(pageWidth) || 1;

    for (const line of createPdfLines(
      Array.isArray(fragments) ? fragments : [],
      normalizedPageWidth
    )) {
      const block = blocks.findLast((candidate) => (
        shouldMergePdfLine(candidate, line, normalizedPageWidth)
      ));

      if (block) {
        block.lines.push(line);
      } else {
        blocks.push({ lines: [line] });
      }
    }

    return blocks.map(({ lines }) => finalizePdfBlock(lines, normalizedPageWidth));
  }

  function isHorizontalPdfTextTransform(transform, vertical = false) {
    if (!Array.isArray(transform)
      || !Number.isFinite(Number(transform[0]))
      || !Number.isFinite(Number(transform[1]))) {
      return false;
    }

    let angle = Math.atan2(Number(transform[1]), Number(transform[0]));

    if (vertical) {
      angle += Math.PI / 2;
    }

    return Math.abs(Math.sin(angle)) <= 0.12;
  }

  function isSupportedPdfTextTransform(displayTransform, vertical = false) {
    if (!isHorizontalPdfTextTransform(displayTransform, vertical)) {
      return false;
    }

    let angle = Math.atan2(Number(displayTransform[1]), Number(displayTransform[0]));

    if (vertical) {
      angle += Math.PI / 2;
    }

    return Math.cos(angle) > 0;
  }

  function getBoundedPdfRenderScale(
    width,
    height,
    preferredScale,
    maximumPixels,
    maximumDimension
  ) {
    const normalizedWidth = Number(width);
    const normalizedHeight = Number(height);
    const normalizedScale = Number(preferredScale);
    const pixelLimit = Number(maximumPixels);
    const dimensionLimit = Number(maximumDimension);

    if (!Number.isFinite(normalizedWidth)
      || !Number.isFinite(normalizedHeight)
      || !Number.isFinite(normalizedScale)
      || !Number.isFinite(pixelLimit)
      || !Number.isFinite(dimensionLimit)
      || normalizedWidth <= 0
      || normalizedHeight <= 0
      || normalizedScale <= 0
      || pixelLimit < 1
      || dimensionLimit < 1) {
      return 0;
    }

    const scale = Math.min(
      normalizedScale,
      Math.sqrt(pixelLimit / (normalizedWidth * normalizedHeight)),
      dimensionLimit / normalizedWidth,
      dimensionLimit / normalizedHeight
    );

    return Number.isFinite(scale) && scale > 0 ? scale : 0;
  }

  function getPdfTextMaskRectangle(
    line,
    scale,
    canvasWidth,
    canvasHeight
  ) {
    const normalizedScale = Math.max(0, Number(scale) || 0);
    const fontSize = Number(line?.fontSize || line?.height || 0);

    if (!normalizedScale) {
      return { height: 0, width: 0, x: 0, y: 0 };
    }

    const horizontalPadding = Math.max(
      2,
      Math.min(normalizedScale * 2, fontSize * normalizedScale * 0.2)
    );
    const verticalPadding = Math.max(
      2,
      Math.min(normalizedScale * 3, fontSize * normalizedScale * 0.28)
    );
    const left = Math.max(
      0,
      Math.floor(Number(line?.x || 0) * normalizedScale - horizontalPadding)
    );
    const top = Math.max(
      0,
      Math.floor(Number(line?.y || 0) * normalizedScale - verticalPadding)
    );
    const right = Math.min(
      Math.max(0, Number(canvasWidth) || 0),
      Math.ceil(
        (Number(line?.x || 0) + Number(line?.width || 0)) * normalizedScale
          + horizontalPadding
      )
    );
    const bottom = Math.min(
      Math.max(0, Number(canvasHeight) || 0),
      Math.ceil(
        (Number(line?.y || 0) + Number(line?.height || 0)) * normalizedScale
          + verticalPadding
      )
    );

    return {
      height: Math.max(0, bottom - top),
      width: Math.max(0, right - left),
      x: left,
      y: top
    };
  }

  function selectPdfBackgroundChannels(samples) {
    const groups = new Map();

    for (const sample of Array.isArray(samples) ? samples : []) {
      if (!Array.isArray(sample) || sample.length < 3) {
        continue;
      }

      const channels = sample.slice(0, 3).map((channel) => (
        Math.max(0, Math.min(255, Math.round(Number(channel) || 0)))
      ));
      const key = channels.map((channel) => Math.round(channel / 8)).join(":");
      const group = groups.get(key) || [];
      group.push(channels);
      groups.set(key, group);
    }

    const dominant = [...groups.values()]
      .sort((left, right) => right.length - left.length)[0] || [[255, 255, 255]];

    return [0, 1, 2].map((channel) => {
      const values = dominant
        .map((sample) => sample[channel])
        .sort((left, right) => left - right);
      return values[Math.floor(values.length / 2)];
    });
  }

  function extractPdfText(items) {
    let text = "";

    for (const item of Array.isArray(items) ? items : []) {
      const value = typeof item?.str === "string" ? item.str : "";

      if (!value) {
        continue;
      }

      if (text && !/[\s\u00a0-]$/u.test(text) && !/^[,.;:!?%)\]}]/u.test(value)) {
        text += " ";
      }

      text += value;

      if (item.hasEOL) {
        text += "\n";
      }
    }

    return text
      .normalize("NFC")
      .replace(/[ \t\u00a0]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  }

  function getDocumentSegmentSeparator(text, end) {
    if (end >= text.length) {
      return "";
    }

    const boundary = text.slice(Math.max(0, end - 2), Math.min(text.length, end + 3));

    if (/\r?\n[ \t]*\r?\n/u.test(boundary)) {
      return "\n\n";
    }

    if (/\r?\n/u.test(boundary)) {
      return "\n";
    }

    return /\s/u.test(`${text[end - 1] || ""}${text[end] || ""}`) ? " " : "";
  }

  function splitDocumentTextParts(value, maximumCharacters = 7000) {
    const text = String(value ?? "").normalize("NFC").trim();
    const limit = Math.max(1, Math.floor(Number(maximumCharacters) || 1));
    const parts = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(text.length, start + limit);

      if (end < text.length) {
        const minimumBreak = start + Math.floor(limit * 0.55);
        const breakCandidates = [
          text.lastIndexOf("\n\n", end),
          text.lastIndexOf("\n", end),
          text.lastIndexOf(". ", end),
          text.lastIndexOf(" ", end)
        ];
        const bestBreak = breakCandidates.find((candidate) => candidate >= minimumBreak);

        if (bestBreak !== undefined) {
          end = bestBreak + (text.startsWith("\n\n", bestBreak) ? 2 : 1);
        } else if (text.charCodeAt(end - 1) >= 0xD800
          && text.charCodeAt(end - 1) <= 0xDBFF
          && text.charCodeAt(end) >= 0xDC00
          && text.charCodeAt(end) <= 0xDFFF) {
          end += 1;
        }
      }

      const chunk = text.slice(start, end).trim();

      if (chunk) {
        parts.push({
          separator: getDocumentSegmentSeparator(text, end),
          text: chunk
        });
      }

      start = end;
    }

    return parts;
  }

  function splitDocumentText(value, maximumCharacters = 7000) {
    return splitDocumentTextParts(value, maximumCharacters).map(({ text }) => text);
  }

  function createDocumentTranslationSegments(id, value, maximumCharacters = 7000) {
    const parts = splitDocumentTextParts(value, maximumCharacters);

    return parts.map(({ separator, text }, index) => ({
      count: parts.length,
      id: parts.length === 1 ? String(id) : `${id}:s${index}`,
      index,
      separator,
      text
    }));
  }

  function applyDocumentTranslationSegment(block, segmentIndex, segmentCount, translation) {
    if (!block
      || !Array.isArray(block.translationSegments)
      || block.translationSegments.length !== segmentCount
      || !Number.isInteger(segmentIndex)
      || segmentIndex < 0
      || segmentIndex >= segmentCount
      || typeof translation !== "string"
      || !translation) {
      throw new Error("The translated PDF block no longer exists.");
    }

    const segment = block.translationSegments[segmentIndex];

    if (!segment || typeof segment.separator !== "string") {
      throw new Error("The translated PDF block no longer exists.");
    }

    segment.translation = translation;

    if (!block.translationSegments.every((item) => item?.translation)) {
      return false;
    }

    block.translation = block.translationSegments
      .map(({ separator, translation: value }) => `${value}${separator}`)
      .join("");
    delete block.translationSegments;
    return true;
  }

  function getTranslatedPagePreviewMode(blocks, documentTranslated) {
    const pageBlocks = Array.isArray(blocks) ? blocks : [];

    if (pageBlocks.some(({ translation }) => Boolean(translation))) {
      return "translated";
    }

    return pageBlocks.length === 0 && documentTranslated ? "original" : "pending";
  }

  function createTranslationBatches(items, maximumItems = 24, maximumCharacters = 9000) {
    const batches = [];
    let batch = [];
    let characters = 0;

    for (const item of Array.isArray(items) ? items : []) {
      const itemCharacters = String(item?.text || "").length + String(item?.context || "").length;
      const exceedsLimit = batch.length > 0
        && (batch.length >= maximumItems || characters + itemCharacters > maximumCharacters);

      if (exceedsLimit) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }

      batch.push(item);
      characters += itemCharacters;
    }

    if (batch.length > 0) {
      batches.push(batch);
    }

    return batches;
  }

  return {
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
  };
});
