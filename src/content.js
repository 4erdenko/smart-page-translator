(function initializeContentScript() {
  const api = globalThis.browser;
  const { t } = globalThis.SmartTranslationUiI18n;
  const {
    addPageLanguageContext,
    findClosestTextKindElement,
    getBrandTermVariants,
    getImplicitOptionValue,
    getInheritedTextKind,
    getSafeContextText,
    getTranslatableAttributes,
    isBlockedAttributeElement,
    isBlockedElement,
    isEditableElement,
    isLikelyPersonalName,
    normalizeLanguageCode,
    normalizeText,
    resolveOriginalText,
    resolveRequestSourceLanguage,
    selectProtectedTerms,
    shouldAutoTranslateLanguage,
    shouldDetectPageLanguage,
    shouldRefreshRoutePolicy,
    shouldStartTranslation,
    shouldTranslateText,
    splitBoundaryWhitespace,
    splitTextForTranslation
  } = globalThis.SmartTranslationDomCore;

  const MAX_BATCH_ITEMS = 48;
  const MAX_BATCH_CHARACTERS = 10000;
  const MAX_BRAND_TERMS = 512;
  const MAX_DOM_UPDATES_PER_SLICE = 160;
  const MAX_DOCUMENT_SCAN_NODES_PER_SLICE = 600;
  const MAX_LANGUAGE_SAMPLE_NODES = 6000;
  const MAX_PENDING_SCAN_ROOTS = 256;
  const MAX_PENDING_TARGETS = 5000;
  const MAX_PARALLEL_BATCHES = 2;
  const MAX_PROTECTED_TERMS_PER_ITEM = 20;
  const MAX_SELECTION_CHARACTERS = 4000;
  const MAX_TEXT_SEGMENT_CHARACTERS = 8000;
  const MAX_ANIMATED_TEXT_RECTS = 12;
  const MIN_TRANSLATION_MOTION_MS = 720;
  const MAX_CLEANUP_ITEMS_PER_SLICE = 240;
  const MAX_RESTORE_ITEMS_PER_SLICE = 160;
  const MAX_VIEW_SWITCH_ITEMS_PER_SLICE = 160;
  const CLEANUP_DELAY = 800;
  const QUEUE_BACKOFF_MS = 1500;
  const OFFSCREEN_BATCH_DELAY = 160;
  const RECOVERY_SCAN_DELAY = 320;
  const SCAN_DELAY = 48;
  const SCAN_TIME_BUDGET_MS = 8;
  const site = resolveSite();
  const observedRootRefs = new Set();
  const observedRootLookup = new WeakMap();
  const trackedTextRefs = new Set();
  const trackedAttributeRecords = new Set();
  const brandTerms = new Set();
  const wholeBrandTerms = new Set();
  const pendingSegments = new Map();
  const pendingTranslationMotions = new Map();
  const pendingScanRootRefs = new Set();
  const subtreeScanJobs = [];
  const visiblePendingCounts = new Map();
  const visibilityElementRefs = new Set();
  let textRecords = new WeakMap();
  let trackedTextLookup = new WeakMap();
  let attributeRecords = new WeakMap();
  let pendingScanRootLookup = new WeakMap();
  let subtreeScanJobLookup = new WeakMap();
  let queuedTextNodes = new WeakSet();
  let queuedAttributes = new WeakMap();
  let activeBatchCount = 0;
  let activeBrandScanCount = 0;
  let activeOffscreenBatchCount = 0;
  let activeMotionElementCount = 0;
  let cleanupJob;
  let cleanupRequested = false;
  let cleanupTimer;
  let currentSettings = {};
  let currentUrl = location.href;
  let documentRescanRequested = false;
  let documentScanInProgress = false;
  let documentScanTimer;
  let flushTimer;
  let flushIdleHandle;
  let flushScheduledForOffscreen = false;
  let motionHost;
  let motionRoot;
  let motionRequestSequence = 0;
  let lastActiveViewMode = "translated";
  let observerActive = false;
  let pendingTargetCount = 0;
  let policyRevision = 0;
  let settingsRefreshRevision = 0;
  let queueBackoffUntil = 0;
  let recoveryScanTimer;
  let restoreJob;
  let revision = 0;
  let routePollTimer;
  let routePolicyTimer;
  let routeRescanPending = false;
  let routeScanTimer;
  let scanTimer;
  let selectionHost;
  let selectionRequestRevision = 0;
  let selectionRoot;
  let subtreeScanTimer;
  let translationCancellationPromise = Promise.resolve();
  let viewSwitchJob;
  let visibilityElementLookup = new WeakMap();
  let needsFullRescan = false;
  const state = {
    animationEnabled: true,
    apiItems: 0,
    autoTranslateLanguages: [],
    cacheEntries: null,
    cacheHits: 0,
    detectedLanguage: "",
    enabled: false,
    error: "",
    model: "deepseek-v4-flash",
    preferredViewMode: "translated",
    provider: "deepseek",
    protectedTerms: [],
    siteMode: "auto",
    sourceLanguage: "auto",
    targetLanguage: "ru",
    translatedElements: 0,
    translating: false,
    viewMode: "translated"
  };

  function isTranslationViewActive() {
    return state.enabled
      && ["bilingual", "translated"].includes(state.viewMode)
      && !state.error
      && !restoreJob
      && !viewSwitchJob;
  }

  function getBilingualText(record) {
    if (record.semanticKind === "interface") {
      return record.translated;
    }

    const original = splitBoundaryWhitespace(record.original);
    const translated = splitBoundaryWhitespace(record.translated);

    return `${original.leading}${original.core} · ${translated.core}${original.trailing}`;
  }

  function getDisplayedText(record, viewMode = state.viewMode) {
    if (viewMode === "original") {
      return record.original;
    }

    return viewMode === "bilingual" ? getBilingualText(record) : record.translated;
  }

  function getDisplayedAttribute(record, viewMode = state.viewMode) {
    return viewMode === "original" ? record.original : record.translated;
  }

  const observer = new MutationObserver((mutations) => {
    let removedContent = false;

    if (checkRouteChange()) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        scheduleScan(mutation.target);
        continue;
      }

      if (mutation.type === "attributes") {
        scheduleScan(mutation.target);
        continue;
      }

      removedContent ||= mutation.removedNodes.length > 0;

      for (const node of mutation.addedNodes) {
        scheduleScan(node);
      }
    }

    if (removedContent) {
      scheduleCleanup();
    }
  });

  const visibilityObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const record = visibilityElementLookup.get(entry.target);

        if (!record || record.visible === entry.isIntersecting) {
          continue;
        }

        record.visible = entry.isIntersecting;

        for (const [segment, count] of record.segments) {
          updateVisiblePendingCount(segment, entry.isIntersecting ? count : -count);
        }
      }

      scheduleFlush();
    }, { rootMargin: "240px 0px" })
    : null;

  function resolveSite() {
    try {
      if (window.top !== window && document.referrer) {
        return new URL(document.referrer).origin;
      }
    } catch {
      return location.origin;
    }

    return location.origin;
  }

  function createWeakReference(value) {
    return new WeakRef(value);
  }

  function publicStatus() {
    return {
      activation: state.siteMode === "always"
        ? "site"
        : state.siteMode === "session"
          ? "manual"
          : state.enabled
            ? "language"
            : "off",
      apiItems: state.apiItems,
      cacheEntries: state.cacheEntries,
      cacheHits: state.cacheHits,
      detectedLanguage: state.detectedLanguage,
      enabled: state.enabled,
      error: state.error,
      model: state.model,
      provider: state.provider,
      protectedTerms: state.protectedTerms.length,
      site,
      siteMode: state.siteMode,
      trackedReferences: trackedTextRefs.size + trackedAttributeRecords.size + observedRootRefs.size,
      translatedElements: state.translatedElements,
      translating: state.translating,
      viewMode: state.viewMode
    };
  }

  function reportStatus() {
    api.runtime.sendMessage({ type: "translationStatus", status: publicStatus() }).catch(() => undefined);
  }

  function observeRoot(root) {
    if (!root || observedRootLookup.has(root)) {
      return;
    }

    const reference = createWeakReference(root);
    observedRootLookup.set(root, reference);
    observedRootRefs.add(reference);

    if (observerActive) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["alt", "aria-description", "aria-label", "label", "placeholder", "title", "value"],
        characterData: true,
        childList: true,
        subtree: true
      });
    }
  }

  function pauseObserver() {
    observer.disconnect();
    observerActive = false;
  }

  function resumeObserver() {
    if (!isTranslationViewActive()) {
      return;
    }

    observerActive = true;

    for (const reference of observedRootRefs) {
      const root = reference.deref();
      const connected = root && (root === document || !root.host || root.host.isConnected);

      if (!connected) {
        observedRootRefs.delete(reference);

        if (root) {
          observedRootLookup.delete(root);
        }

        continue;
      }

      try {
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["alt", "aria-description", "aria-label", "label", "placeholder", "title", "value"],
          characterData: true,
          childList: true,
          subtree: true
        });
      } catch {
        observedRootRefs.delete(reference);
        observedRootLookup.delete(root);
      }
    }
  }

  function getElementContext(element, text, attribute = "", kind = "text") {
    const elementName = String(element?.tagName || "text").toLowerCase();
    const label = attribute ? `${elementName}[${attribute}]` : elementName;

    if (attribute || kind === "product-title" || kind === "brand-name") {
      return `${kind}:${label}`;
    }

    const parentText = getSafeContextText(element, 180);

    if (parentText && parentText !== text) {
      return `${kind}:${label}: ${parentText}`;
    }

    return `${kind}:${label}`;
  }

  function getTargetElement(target) {
    return target.kind === "text" ? target.node.deref()?.parentElement : target.element.deref();
  }

  function updateVisiblePendingCount(segment, delta) {
    if (pendingSegments.get(segment.key) !== segment) {
      visiblePendingCounts.delete(segment);
      return;
    }

    const next = Math.max(0, Number(visiblePendingCounts.get(segment) || 0) + delta);

    if (next > 0) {
      visiblePendingCounts.set(segment, next);
    } else {
      visiblePendingCounts.delete(segment);
    }
  }

  function trackPendingVisibility(segment, target) {
    const element = getTargetElement(target);

    if (!visibilityObserver || !element) {
      return;
    }

    let record = visibilityElementLookup.get(element);

    if (!record) {
      record = {
        reference: createWeakReference(element),
        segments: new Map(),
        visible: false
      };
      visibilityElementLookup.set(element, record);
      visibilityElementRefs.add(record.reference);
      visibilityObserver.observe(element);
    }

    record.segments.set(segment, Number(record.segments.get(segment) || 0) + 1);
    target.visibilityElement = record.reference;
    target.visibilitySegment = segment;

    if (record.visible) {
      updateVisiblePendingCount(segment, 1);
    }
  }

  function releasePendingVisibility(target) {
    const element = target.visibilityElement?.deref();
    const segment = target.visibilitySegment;

    if (!element || !segment) {
      return;
    }

    const record = visibilityElementLookup.get(element);
    const count = Number(record?.segments.get(segment) || 0);

    if (!record || count === 0) {
      return;
    }

    if (count === 1) {
      record.segments.delete(segment);
    } else {
      record.segments.set(segment, count - 1);
    }

    if (record.visible) {
      updateVisiblePendingCount(segment, -1);
    }

    if (record.segments.size === 0) {
      visibilityObserver.unobserve(element);
      visibilityElementLookup.delete(element);
      visibilityElementRefs.delete(record.reference);
    }
  }

  function addBrandTerm(value, protectWhole = false) {
    for (const term of getBrandTermVariants(value)) {
      const shouldProtectWhole = protectWhole || wholeBrandTerms.has(term);
      brandTerms.delete(term);

      if (brandTerms.size >= MAX_BRAND_TERMS) {
        const oldestTerm = brandTerms.values().next().value;
        brandTerms.delete(oldestTerm);
        wholeBrandTerms.delete(oldestTerm);
      }

      brandTerms.add(term);

      if (shouldProtectWhole) {
        wholeBrandTerms.add(term);
      }
    }
  }

  function refreshPageBrandTerms() {
    for (const meta of document.querySelectorAll('meta[name="application-name"], meta[property="og:site_name"]')) {
      addBrandTerm(meta.getAttribute("content"), true);
    }
  }

  function getProtectedTermSets() {
    const terms = new Set(brandTerms);
    const wholeTerms = new Set(wholeBrandTerms);

    for (const term of state.protectedTerms) {
      terms.add(term);
      wholeTerms.add(term);
    }

    return { terms, wholeTerms };
  }

  function collectBrandNode(node) {
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const brandElement = findClosestTextKindElement(element, "brand-name");

    if (!brandElement) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if (!isBlockedElement(element)) {
        addBrandTerm(splitBoundaryWhitespace(node.nodeValue ?? "").core, true);
      }

      return;
    }

    if (element !== brandElement || isBlockedAttributeElement(element)) {
      return;
    }

    for (const attribute of getTranslatableAttributes(element)) {
      if (element.hasAttribute(attribute)) {
        addBrandTerm(splitBoundaryWhitespace(element.getAttribute(attribute) ?? "").core, true);
      }
    }
  }

  function finishBrandScan(job) {
    if (!job.brandScanActive) {
      return;
    }

    job.brandScanActive = false;
    activeBrandScanCount = Math.max(0, activeBrandScanCount - 1);

    if (activeBrandScanCount === 0) {
      scheduleFlush();
    }
  }

  function addPendingTarget(text, context, kind, target) {
    if (pendingTargetCount >= MAX_PENDING_TARGETS) {
      needsFullRescan = true;
      return false;
    }

    const normalizedText = normalizeText(text);
    const normalizedContext = normalizeText(context);
    const key = `${normalizedText}\u0000${normalizedContext}\u0000${kind}`;
    const segment = pendingSegments.get(key) || {
      context: normalizedContext,
      key,
      kind,
      protectedTerms: [],
      targets: [],
      text: normalizedText
    };

    segment.targets.push(target);
    pendingSegments.set(key, segment);
    pendingTargetCount += 1;
    trackPendingVisibility(segment, target);
    return true;
  }

  function markAttributeQueued(element, attribute) {
    const attributes = queuedAttributes.get(element) || new Set();

    if (attributes.has(attribute)) {
      return false;
    }

    attributes.add(attribute);
    queuedAttributes.set(element, attributes);
    return true;
  }

  function releaseQueuedTarget(target) {
    releasePendingVisibility(target);

    target.assembly.releaseRemaining -= 1;

    if (target.assembly.releaseRemaining > 0) {
      return;
    }

    if (target.kind === "text") {
      const node = target.node.deref();

      if (node) {
        queuedTextNodes.delete(node);
      }

      return;
    }

    const element = target.element.deref();

    if (!element) {
      return;
    }

    const attributes = queuedAttributes.get(element);
    attributes?.delete(target.attribute);

    if (attributes?.size === 0) {
      queuedAttributes.delete(element);
    }
  }

  function collectTextNode(node) {
    if (!isTranslationViewActive() || !node?.parentElement || isBlockedElement(node.parentElement)) {
      return;
    }

    const currentValue = node.nodeValue ?? "";
    const existing = textRecords.get(node);

    if (existing && currentValue === existing.displayed) {
      return;
    }

    const parts = splitBoundaryWhitespace(currentValue);
    const textKind = getInheritedTextKind(node.parentElement);

    if (textKind === "brand-name" || isLikelyPersonalName(node.parentElement, parts.core, textKind)) {
      if (textKind === "brand-name") {
        addBrandTerm(parts.core, true);
      }

      return;
    }

    if (!shouldTranslateText(parts.core) || queuedTextNodes.has(node)) {
      return;
    }

    const chunks = splitTextForTranslation(parts.core, MAX_TEXT_SEGMENT_CHARACTERS);

    if (pendingTargetCount + chunks.length > MAX_PENDING_TARGETS) {
      needsFullRescan = true;
      scheduleRecoveryScan();
      return;
    }

    const nodeReference = createWeakReference(node);
    const assembly = createTranslationAssembly(chunks, currentValue, parts);

    queuedTextNodes.add(node);

    chunks.forEach((chunk, partIndex) => {
      const target = {
        assembly,
        kind: "text",
        leading: parts.leading,
        node: nodeReference,
        original: currentValue,
        partIndex,
        semanticKind: textKind,
        trailing: parts.trailing
      };

      addPendingTarget(
        chunk.text,
        getElementContext(node.parentElement, chunk.text, "", textKind),
        textKind,
        target
      );
    });
  }

  function buildAssembledTranslation(assembly) {
    return assembly.chunks.map((chunk, index) => (
      `${normalizeText(assembly.translations[index])}${chunk.separator}`
    )).join("");
  }

  function createTranslationAssembly(chunks, original, parts) {
    return {
      chunks,
      completed: false,
      leading: parts.leading,
      original,
      releaseRemaining: chunks.length,
      remaining: chunks.length,
      trailing: parts.trailing,
      translations: new Array(chunks.length)
    };
  }

  function recordAssemblyTranslation(assembly, partIndex, translation) {
    if (!Object.hasOwn(assembly.translations, partIndex)) {
      assembly.translations[partIndex] = translation;
      assembly.remaining -= 1;
    }

    return assembly.remaining === 0;
  }

  function collectAttribute(element, attribute) {
    if (!isTranslationViewActive() || !element.hasAttribute(attribute) || isBlockedAttributeElement(element)) {
      return;
    }

    const currentValue = element.getAttribute(attribute) ?? "";
    const existing = attributeRecords.get(element)?.get(attribute);

    if (existing && currentValue === existing.displayed) {
      return;
    }

    const parts = splitBoundaryWhitespace(currentValue);
    const textKind = getInheritedTextKind(element);

    if (textKind === "brand-name" || isLikelyPersonalName(element, parts.core, textKind)) {
      if (textKind === "brand-name") {
        addBrandTerm(parts.core, true);
      }

      return;
    }

    if (!shouldTranslateText(parts.core)) {
      return;
    }

    const chunks = splitTextForTranslation(parts.core, MAX_TEXT_SEGMENT_CHARACTERS);

    if (pendingTargetCount + chunks.length > MAX_PENDING_TARGETS) {
      needsFullRescan = true;
      scheduleRecoveryScan();
      return;
    }

    if (!markAttributeQueued(element, attribute)) {
      return;
    }

    const elementReference = createWeakReference(element);
    const assembly = createTranslationAssembly(chunks, currentValue, parts);

    chunks.forEach((chunk, partIndex) => {
      addPendingTarget(
        chunk.text,
        getElementContext(element, chunk.text, attribute, textKind),
        textKind,
        {
          assembly,
          attribute,
          element: elementReference,
          kind: "attribute",
          partIndex
        }
      );
    });
  }

  function collectElement(element) {
    if (!element) {
      return;
    }

    for (const attribute of getTranslatableAttributes(element)) {
      if (element.hasAttribute(attribute)) {
        collectAttribute(element, attribute);
      }
    }

    if (isBlockedElement(element)) {
      return;
    }

    if (element.shadowRoot) {
      observeRoot(element.shadowRoot);
      scanSubtree(element.shadowRoot);
    }
  }

  function scanDocument() {
    if (documentScanInProgress) {
      documentRescanRequested = true;
      return;
    }

    clearTimeout(documentScanTimer);
    documentScanTimer = undefined;
    documentScanInProgress = true;
    documentRescanRequested = false;
    refreshPageBrandTerms();
    const scanJob = { brandScanActive: true };
    let scanPhase = "brands";
    const scanRevision = revision;
    let walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    activeBrandScanCount += 1;

    const finish = () => {
      finishBrandScan(scanJob);
      documentScanInProgress = false;
      scheduleFlush();

      if (documentRescanRequested && isTranslationViewActive()) {
        documentRescanRequested = false;
        documentScanTimer = setTimeout(() => {
          documentScanTimer = undefined;
          scanDocument();
        }, 0);
      }
    };

    const scanSlice = () => {
      if (!isTranslationViewActive() || scanRevision !== revision) {
        finish();
        return;
      }

      const startedAt = performance.now();
      let processed = 0;
      let node = walker.nextNode();

      while (node) {
        if (scanPhase === "brands") {
          collectBrandNode(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          collectTextNode(node);
        } else {
          collectElement(node);
        }

        processed += 1;

        if (processed >= MAX_DOCUMENT_SCAN_NODES_PER_SLICE
          || performance.now() - startedAt >= SCAN_TIME_BUDGET_MS) {
          if (scanPhase === "content") {
            scheduleFlush();
          }

          documentScanTimer = setTimeout(() => {
            documentScanTimer = undefined;
            scanSlice();
          }, 0);
          return;
        }

        node = walker.nextNode();
      }

      if (scanPhase === "brands") {
        finishBrandScan(scanJob);
        scanPhase = "content";
        walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        documentScanTimer = setTimeout(() => {
          documentScanTimer = undefined;
          scanSlice();
        }, 0);
        return;
      }

      finish();
    };

    scanSlice();
  }

  function scanSubtree(root) {
    if (!isTranslationViewActive() || !root) {
      return;
    }

    if (root === document) {
      scanDocument();
      return;
    }

    if (root.nodeType === Node.TEXT_NODE) {
      collectTextNode(root);
      scheduleFlush();
      return;
    }

    const existingJob = subtreeScanJobLookup.get(root);

    if (existingJob) {
      existingJob.rescanRequested = true;
      return;
    }

    if (subtreeScanJobs.length >= MAX_PENDING_SCAN_ROOTS) {
      needsFullRescan = true;
      scheduleRecoveryScan();
      return;
    }

    const job = {
      brandScanActive: true,
      phase: "brands",
      reference: createWeakReference(root),
      rescanRequested: false,
      revision,
      rootPending: true,
      walker: null
    };
    activeBrandScanCount += 1;
    subtreeScanJobLookup.set(root, job);
    subtreeScanJobs.push(job);
    scheduleSubtreeScan();
  }

  function scheduleSubtreeScan() {
    if (subtreeScanTimer) {
      return;
    }

    subtreeScanTimer = setTimeout(runSubtreeScans, 0);
  }

  function finishSubtreeScan(job, root) {
    finishBrandScan(job);
    subtreeScanJobs.shift();

    if (root) {
      subtreeScanJobLookup.delete(root);
    }

    if (job.rescanRequested && root && (root.isConnected || root.host?.isConnected)) {
      scanSubtree(root);
    }
  }

  function runSubtreeScans() {
    subtreeScanTimer = undefined;
    const startedAt = performance.now();
    let processed = 0;

    while (subtreeScanJobs.length > 0) {
      const job = subtreeScanJobs[0];
      const root = job.reference.deref();

      if (!isTranslationViewActive()
        || job.revision !== revision
        || !root
        || (!root.isConnected && !root.host?.isConnected)) {
        finishSubtreeScan(job, root);
        continue;
      }

      if (job.rootPending) {
        job.rootPending = false;

        if (root.nodeType === Node.ELEMENT_NODE) {
          if (job.phase === "brands") {
            collectBrandNode(root);
          } else {
            collectElement(root);
          }
        }

        job.walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      }

      const node = job.walker.nextNode();

      if (!node) {
        if (job.phase === "brands") {
          finishBrandScan(job);
          job.phase = "content";
          job.rootPending = true;
          job.walker = null;
          continue;
        }

        finishSubtreeScan(job, root);
        scheduleFlush();
        continue;
      }

      if (job.phase === "brands") {
        collectBrandNode(node);
      } else if (node.nodeType === Node.TEXT_NODE) {
        collectTextNode(node);
      } else {
        collectElement(node);
      }

      processed += 1;

      if (processed >= MAX_DOCUMENT_SCAN_NODES_PER_SLICE
        || performance.now() - startedAt >= SCAN_TIME_BUDGET_MS) {
        break;
      }
    }

    scheduleFlush();

    if (subtreeScanJobs.length > 0) {
      scheduleSubtreeScan();
    }
  }

  function compactScanRoots() {
    const roots = [...pendingScanRootRefs]
      .map((reference) => reference.deref())
      .filter((root) => root === document || root?.isConnected || root?.host?.isConnected);
    const rootSet = new Set(roots);
    pendingScanRootRefs.clear();
    pendingScanRootLookup = new WeakMap();

    return roots.filter((root) => {
      let parent = root?.parentNode || root?.host || null;

      while (parent) {
        if (rootSet.has(parent)) {
          return false;
        }

        parent = parent.parentNode || parent.host || null;
      }

      return true;
    });
  }

  function scheduleScan(root) {
    if (!isTranslationViewActive() || !root) {
      return;
    }

    if (!pendingScanRootLookup.has(root)) {
      if (pendingScanRootRefs.size >= MAX_PENDING_SCAN_ROOTS) {
        needsFullRescan = true;
        scheduleRecoveryScan();
        return;
      }

      const reference = createWeakReference(root);
      pendingScanRootLookup.set(root, reference);
      pendingScanRootRefs.add(reference);
    }

    if (scanTimer) {
      return;
    }

    scanTimer = setTimeout(() => {
      scanTimer = undefined;

      for (const pendingRoot of compactScanRoots()) {
        scanSubtree(pendingRoot);
      }
    }, SCAN_DELAY);
  }

  function scheduleRecoveryScan() {
    clearTimeout(recoveryScanTimer);
    recoveryScanTimer = setTimeout(() => {
      recoveryScanTimer = undefined;

      if (documentScanInProgress
        || subtreeScanJobs.length > 0
        || pendingScanRootRefs.size > 0
        || pendingSegments.size > 0
        || activeBatchCount > 0) {
        scheduleRecoveryScan();
        return;
      }

      needsFullRescan = false;

      if (isTranslationViewActive()) {
        scanSubtree(document);
      }
    }, RECOVERY_SCAN_DELAY);
  }

  function takeBatch(visibleOnly = false) {
    const selected = [];
    let characters = 0;
    const { terms, wholeTerms } = getProtectedTermSets();

    const takeSegment = (key, segment) => {
      const segmentCharacters = segment.text.length + segment.context.length;
      const exceedsLimit = selected.length > 0
        && (selected.length >= MAX_BATCH_ITEMS || characters + segmentCharacters > MAX_BATCH_CHARACTERS);

      if (exceedsLimit) {
        return false;
      }

      segment.protectedTerms = selectProtectedTerms(
        segment.text,
        terms,
        segment.kind,
        wholeTerms
      ).slice(0, MAX_PROTECTED_TERMS_PER_ITEM);
      pendingSegments.delete(key);
      visiblePendingCounts.delete(segment);
      pendingTargetCount = Math.max(0, pendingTargetCount - segment.targets.length);
      selected.push(segment);
      characters += segmentCharacters;
      return true;
    };

    for (const segment of visiblePendingCounts.keys()) {
      const key = segment.key;

      if (pendingSegments.get(key) !== segment) {
        visiblePendingCounts.delete(segment);
        continue;
      }

      if (!takeSegment(key, segment)) {
        return selected;
      }
    }

    if (visibleOnly) {
      return selected;
    }

    for (const [key, segment] of pendingSegments) {
      if (visiblePendingCounts.has(segment)) {
        continue;
      }

      if (!takeSegment(key, segment)) {
        break;
      }
    }

    return selected;
  }

  function trackTextNode(node) {
    if (trackedTextLookup.has(node)) {
      return;
    }

    const reference = createWeakReference(node);
    trackedTextLookup.set(node, reference);
    trackedTextRefs.add(reference);
  }

  function preserveImplicitOptionValue(node) {
    const option = node?.parentElement?.closest?.("option");
    const value = getImplicitOptionValue(option);

    if (value === null) {
      return;
    }

    const records = attributeRecords.get(option) || new Map();
    const record = {
      attribute: "value",
      displayed: value,
      element: createWeakReference(option),
      original: null,
      translated: value
    };

    records.set("value", record);
    attributeRecords.set(option, records);
    trackedAttributeRecords.add(record);
    option.setAttribute("value", value);
  }

  function applyTextTarget(target, translation) {
    const assembly = target.assembly;
    const node = target.node.deref();

    if (assembly.completed) {
      return false;
    }

    if (!node?.isConnected || node.nodeValue !== assembly.original) {
      needsFullRescan = true;

      if (node?.isConnected) {
        scheduleScan(node);
      }

      return false;
    }

    if (!recordAssemblyTranslation(assembly, target.partIndex, translation)) {
      return false;
    }

    assembly.completed = true;
    const translated = `${assembly.leading}${buildAssembledTranslation(assembly)}${assembly.trailing}`;

    if (translated === assembly.original) {
      return false;
    }

    preserveImplicitOptionValue(node);
    const record = {
      displayed: translated,
      original: assembly.original,
      semanticKind: target.semanticKind,
      translated
    };
    record.displayed = getDisplayedText(record);
    textRecords.set(node, record);
    trackTextNode(node);
    node.nodeValue = record.displayed;
    return true;
  }

  function applyAttributeTarget(target, translation) {
    const assembly = target.assembly;
    const element = target.element.deref();

    if (assembly.completed) {
      return false;
    }

    if (!element?.isConnected || element.getAttribute(target.attribute) !== assembly.original) {
      needsFullRescan = true;

      if (element?.isConnected) {
        scheduleScan(element);
      }

      return false;
    }

    if (!recordAssemblyTranslation(assembly, target.partIndex, translation)) {
      return false;
    }

    assembly.completed = true;
    const translated = `${assembly.leading}${buildAssembledTranslation(assembly)}${assembly.trailing}`;

    if (translated === assembly.original) {
      return false;
    }

    const records = attributeRecords.get(element) || new Map();
    let record = records.get(target.attribute);

    if (record) {
      record.displayed = translated;
      record.original = assembly.original;
      record.translated = translated;
    } else {
      record = {
        attribute: target.attribute,
        displayed: translated,
        element: createWeakReference(element),
        original: assembly.original,
        translated
      };
      records.set(target.attribute, record);
      trackedAttributeRecords.add(record);
    }

    attributeRecords.set(element, records);
    element.setAttribute(target.attribute, translated);
    return true;
  }

  function createCleanupJob() {
    return {
      pendingSegment: null,
      phaseIndex: 0,
      phases: [
        { iterator: trackedTextRefs.values(), remaining: trackedTextRefs.size, type: "text" },
        { iterator: trackedAttributeRecords.values(), remaining: trackedAttributeRecords.size, type: "attribute" },
        { iterator: observedRootRefs.values(), remaining: observedRootRefs.size, type: "root" },
        { iterator: visibilityElementRefs.values(), remaining: visibilityElementRefs.size, type: "visibility" },
        { iterator: pendingSegments.entries(), remaining: pendingSegments.size, type: "pending" }
      ],
      rootsChanged: false
    };
  }

  function processCleanupValue(job, type, value) {
    if (type === "text") {
      const node = value.deref();

      if (!node || !node.isConnected) {
        trackedTextRefs.delete(value);

        if (node) {
          trackedTextLookup.delete(node);
          textRecords.delete(node);
        }
      }
    } else if (type === "attribute") {
      const element = value.element.deref();

      if (!element || !element.isConnected) {
        trackedAttributeRecords.delete(value);
      }
    } else if (type === "root") {
      const root = value.deref();

      if (!root || (root !== document && root.host && !root.host.isConnected)) {
        observedRootRefs.delete(value);
        job.rootsChanged = true;

        if (root) {
          observedRootLookup.delete(root);
        }
      }
    } else if (type === "visibility") {
      const element = value.deref();

      if (!element || !element.isConnected) {
        const record = element ? visibilityElementLookup.get(element) : null;

        if (element) {
          visibilityObserver?.unobserve(element);
          visibilityElementLookup.delete(element);
        }

        if (record?.visible) {
          for (const [segment, count] of record.segments) {
            updateVisiblePendingCount(segment, -count);
          }
        }

        visibilityElementRefs.delete(value);
      }
    }
  }

  function processPendingCleanupTarget(job) {
    const pending = job.pendingSegment;

    if (!pending) {
      return false;
    }

    const target = pending.segment.targets[pending.targetIndex];
    pending.targetIndex += 1;
    const element = getTargetElement(target);

    if (element?.isConnected) {
      pending.connectedTargets.push(target);
    } else {
      releaseQueuedTarget(target);
      pendingTargetCount = Math.max(0, pendingTargetCount - 1);
    }

    if (pending.targetIndex >= pending.segment.targets.length) {
      if (pendingSegments.get(pending.key) === pending.segment) {
        if (pending.connectedTargets.length > 0) {
          pending.segment.targets = pending.connectedTargets;
        } else {
          pendingSegments.delete(pending.key);
          visiblePendingCounts.delete(pending.segment);
        }
      }

      job.pendingSegment = null;
    }

    return true;
  }

  function processNextCleanupItem(job) {
    if (processPendingCleanupTarget(job)) {
      return true;
    }

    while (job.phaseIndex < job.phases.length) {
      const phase = job.phases[job.phaseIndex];

      if (phase.remaining <= 0) {
        job.phaseIndex += 1;
        continue;
      }

      const next = phase.iterator.next();
      phase.remaining -= 1;

      if (next.done) {
        job.phaseIndex += 1;
        continue;
      }

      if (phase.type === "pending") {
        const [key, segment] = next.value;

        if (pendingSegments.get(key) === segment) {
          job.pendingSegment = { connectedTargets: [], key, segment, targetIndex: 0 };
          return processPendingCleanupTarget(job);
        }
      } else {
        processCleanupValue(job, phase.type, next.value);
        return true;
      }
    }

    return false;
  }

  function runCleanupSlice() {
    cleanupTimer = undefined;
    cleanupJob ||= createCleanupJob();
    const startedAt = performance.now();
    let processed = 0;

    while (processed < MAX_CLEANUP_ITEMS_PER_SLICE
      && performance.now() - startedAt < SCAN_TIME_BUDGET_MS
      && processNextCleanupItem(cleanupJob)) {
      processed += 1;
    }

    if (cleanupJob.phaseIndex < cleanupJob.phases.length || cleanupJob.pendingSegment) {
      cleanupTimer = setTimeout(runCleanupSlice, 0);
      return;
    }

    const rootsChanged = cleanupJob.rootsChanged;
    cleanupJob = undefined;

    if (rootsChanged) {
      pauseObserver();
      resumeObserver();
    }

    if (cleanupRequested) {
      cleanupRequested = false;
      scheduleCleanup();
    }
  }

  function scheduleCleanup(delay = CLEANUP_DELAY) {
    if (cleanupJob) {
      cleanupRequested = true;
      return;
    }

    if (!cleanupTimer) {
      cleanupTimer = setTimeout(runCleanupSlice, delay);
    }
  }

  function canShowMotion() {
    try {
      return state.animationEnabled
        && window.top === window
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        && document.visibilityState === "visible";
    } catch {
      return false;
    }
  }

  function ensureMotionRoot() {
    if (!canShowMotion()) {
      return null;
    }

    if (motionHost?.isConnected && motionRoot) {
      return motionRoot;
    }

    motionHost = document.createElement("div");
    motionHost.setAttribute("data-no-translate", "");
    motionHost.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483646;pointer-events:none;";
    motionRoot = motionHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .layer { width: 0; height: 0; overflow: visible; pointer-events: none; }
      .text-magic {
        position: fixed;
        overflow: hidden;
        border-radius: 3px;
        contain: strict;
        isolation: isolate;
        opacity: .94;
        transform: translateZ(0);
        background: linear-gradient(90deg, rgba(103, 167, 255, .1), rgba(119, 91, 255, .28), rgba(102, 202, 255, .12));
        box-shadow: inset 0 0 0 1px rgba(184, 205, 255, .3), 0 0 8px rgba(109, 135, 255, .16);
        will-change: opacity, transform;
        animation: magic-arrive 240ms cubic-bezier(.22, 1, .36, 1) both;
      }
      .text-magic::before {
        content: "";
        position: absolute;
        inset: -35% -70%;
        background: linear-gradient(102deg, transparent 35%, rgba(154, 205, 255, .22) 43%, rgba(255, 255, 255, .98) 50%, rgba(172, 125, 255, .68) 57%, transparent 66%);
        transform: translate3d(-48%, 0, 0) skewX(-10deg);
        will-change: transform;
        animation: magic-sweep 1080ms cubic-bezier(.45, 0, .2, 1) infinite;
      }
      .text-magic::after {
        content: "";
        position: absolute;
        inset: -55%;
        background:
          radial-gradient(circle at 30% 46%, rgba(255, 255, 255, .95) 0 1px, transparent 1.8px),
          radial-gradient(circle at 61% 30%, rgba(145, 202, 255, .9) 0 1.2px, transparent 2px),
          radial-gradient(circle at 76% 72%, rgba(183, 151, 255, .85) 0 1px, transparent 1.8px);
        opacity: .52;
        transform: translate3d(-8%, 3%, 0) scale(.96);
        will-change: opacity, transform;
        animation: magic-dust 1320ms ease-in-out infinite;
      }
      .text-magic.is-complete {
        animation: magic-complete 300ms cubic-bezier(.22, 1, .36, 1) forwards;
      }
      .text-magic.is-complete::before,
      .text-magic.is-complete::after {
        animation-play-state: paused;
      }
      @keyframes magic-arrive {
        from { opacity: 0; transform: translate3d(0, 1px, 0) scaleX(.985); }
        to { opacity: .94; transform: translate3d(0, 0, 0) scaleX(1); }
      }
      @keyframes magic-sweep {
        from { transform: translate3d(-48%, 0, 0) skewX(-10deg); }
        to { transform: translate3d(48%, 0, 0) skewX(-10deg); }
      }
      @keyframes magic-dust {
        0%, 100% { opacity: .2; transform: translate3d(-8%, 3%, 0) scale(.96); }
        50% { opacity: .68; transform: translate3d(9%, -3%, 0) scale(1.02); }
      }
      @keyframes magic-complete {
        from { opacity: .94; transform: translate3d(0, 0, 0) scaleX(1); }
        to { opacity: 0; transform: translate3d(0, -1px, 0) scaleX(1.015); }
      }
    `;
    const layer = document.createElement("div");
    layer.className = "layer";
    motionRoot.append(style, layer);
    document.documentElement.append(motionHost);
    return motionRoot;
  }

  function getMotionLayer() {
    return ensureMotionRoot()?.querySelector(".layer") || null;
  }

  function finishMotionElement(element) {
    if (!element.isConnected) {
      return;
    }

    let fallbackTimer;
    let removed = false;
    const remove = () => {
      if (removed) {
        return;
      }

      removed = true;
      clearTimeout(fallbackTimer);
      element.removeEventListener("animationend", handleAnimationEnd);
      const layer = element.parentElement;
      element.remove();
      activeMotionElementCount = Math.max(0, activeMotionElementCount - 1);

      if (layer?.isConnected && layer.childElementCount === 0 && motionRoot?.querySelector(".layer") === layer) {
        removeMotion();
      }
    };
    const handleAnimationEnd = (event) => {
      if (event.animationName === "magic-complete" && !event.pseudoElement) {
        remove();
      }
    };

    element.addEventListener("animationend", handleAnimationEnd);
    element.classList.add("is-complete");
    fallbackTimer = setTimeout(remove, 420);
  }

  function getTextRectangles(target, limit) {
    if (target.kind !== "text" || limit <= 0) {
      return [];
    }

    const node = target.node.deref();

    if (!node?.isConnected || !node.nodeValue) {
      return [];
    }

    const start = Math.min(target.leading.length, node.nodeValue.length);
    const end = Math.max(start, node.nodeValue.length - target.trailing.length);

    if (start === end) {
      return [];
    }

    const range = document.createRange();
    const rectangles = [];

    try {
      range.setStart(node, start);
      range.setEnd(node, end);

      for (const rectangle of range.getClientRects()) {
        const left = Math.max(0, rectangle.left);
        const right = Math.min(window.innerWidth, rectangle.right);
        const top = Math.max(0, rectangle.top);
        const bottom = Math.min(window.innerHeight, rectangle.bottom);

        if (right - left >= 2 && bottom - top >= 2) {
          rectangles.push({ bottom, left, right, top });
        }

        if (rectangles.length >= limit) {
          break;
        }
      }
    } finally {
      range.detach();
    }

    return rectangles;
  }

  function isTargetNearViewport(target) {
    const element = target.visibilityElement?.deref();
    const visibilityRecord = element && visibilityElementLookup.get(element);

    if (visibilityRecord?.visible) {
      return true;
    }

    const targetElement = element || getTargetElement(target);

    if (!targetElement?.isConnected) {
      return false;
    }

    const rectangle = targetElement.getBoundingClientRect();
    return rectangle.bottom > 0
      && rectangle.right > 0
      && rectangle.top < window.innerHeight
      && rectangle.left < window.innerWidth;
  }

  function startTranslationMotion(batch) {
    const availableRectangles = MAX_ANIMATED_TEXT_RECTS - activeMotionElementCount;

    if (!canShowMotion() || batch.length === 0 || availableRectangles <= 0) {
      return [];
    }

    const rectangles = [];

    for (const segment of batch) {
      for (const target of segment.targets) {
        if (!isTargetNearViewport(target)) {
          continue;
        }

        rectangles.push(...getTextRectangles(target, availableRectangles - rectangles.length));

        if (rectangles.length >= availableRectangles) {
          break;
        }
      }

      if (rectangles.length >= availableRectangles) {
        break;
      }
    }

    if (rectangles.length === 0) {
      return [];
    }

    const layer = getMotionLayer();

    if (!layer) {
      return [];
    }

    return rectangles.map((rectangle, index) => {
      const element = document.createElement("div");
      element.className = "text-magic";
      element.style.left = `${rectangle.left}px`;
      element.style.top = `${rectangle.top}px`;
      element.style.width = `${rectangle.right - rectangle.left}px`;
      element.style.height = `${rectangle.bottom - rectangle.top}px`;
      element.style.animationDelay = `${Math.min(72, index * 6)}ms`;
      layer.append(element);
      activeMotionElementCount += 1;
      return element;
    });
  }

  function createTranslationMotion(batch, batchRevision) {
    let elements = [];
    let finished = false;
    let started = false;
    let startedAt = 0;

    return {
      start() {
        if (!started && !finished && isTranslationViewActive() && batchRevision === revision) {
          started = true;
          startedAt = performance.now();
          elements = startTranslationMotion(batch);
        }
      },
      finish() {
        if (finished) {
          return;
        }

        finished = true;
        const finishElements = () => {
          elements.forEach(finishMotionElement);
          elements = [];
        };
        const remaining = started
          ? Math.max(0, MIN_TRANSLATION_MOTION_MS - (performance.now() - startedAt))
          : 0;

        if (remaining > 0) {
          setTimeout(finishElements, remaining);
        } else {
          finishElements();
        }
      }
    };
  }

  function yieldToPage() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function releaseBatchTargets(batch) {
    let processed = 0;
    let startedAt = performance.now();

    for (const segment of batch) {
      for (const target of segment.targets) {
        releaseQueuedTarget(target);
        processed += 1;

        if (processed >= MAX_DOM_UPDATES_PER_SLICE
          || performance.now() - startedAt >= SCAN_TIME_BUDGET_MS) {
          await yieldToPage();
          processed = 0;
          startedAt = performance.now();
        }
      }
    }
  }

  async function applyBatchTranslations(batch, translations, batchRevision) {
    let applied = 0;
    let segmentIndex = 0;
    let targetIndex = 0;

    while (segmentIndex < batch.length) {
      if (!isTranslationViewActive() || batchRevision !== revision) {
        return { applied, cancelled: true };
      }

      const startedAt = performance.now();
      let processed = 0;
      pauseObserver();

      try {
        while (segmentIndex < batch.length) {
          const segment = batch[segmentIndex];
          const translation = translations.get(String(segmentIndex));

          if (typeof translation !== "string") {
            segmentIndex += 1;
            targetIndex = 0;
            continue;
          }

          const target = segment.targets[targetIndex];

          if (!target) {
            segmentIndex += 1;
            targetIndex = 0;
            continue;
          }

          const didApply = target.kind === "text"
            ? applyTextTarget(target, translation)
            : applyAttributeTarget(target, translation);
          targetIndex += 1;
          processed += 1;

          if (didApply) {
            applied += 1;
          }

          if (processed >= MAX_DOM_UPDATES_PER_SLICE
            || performance.now() - startedAt >= SCAN_TIME_BUDGET_MS) {
            break;
          }
        }
      } finally {
        resumeObserver();
      }

      if (segmentIndex < batch.length) {
        await yieldToPage();
      }
    }

    return { applied, cancelled: false };
  }

  async function processBatch(batch, offscreen = false) {
    const batchRevision = revision;
    motionRequestSequence += 1;
    const motionId = `${revision}:${motionRequestSequence}`;
    const motion = createTranslationMotion(batch, batchRevision);
    pendingTranslationMotions.set(motionId, motion);
    activeBatchCount += 1;
    activeOffscreenBatchCount += offscreen ? 1 : 0;
    state.translating = true;
    state.error = "";

    reportStatus();

    try {
      await translationCancellationPromise;

      if (!isTranslationViewActive() || batchRevision !== revision) {
        return;
      }

      const response = await api.runtime.sendMessage({
        type: "translateBatch",
        motionId,
        sourceLanguage: resolveRequestSourceLanguage(state.sourceLanguage),
        items: batch.map((segment, index) => ({
          id: String(index),
          text: segment.text,
          context: addPageLanguageContext(
            segment.context,
            state.sourceLanguage === "auto" ? state.detectedLanguage : ""
          ),
          kind: segment.kind,
          protectedTerms: segment.protectedTerms
        }))
      });
      motion.finish();

      if (!isTranslationViewActive() || batchRevision !== revision) {
        return;
      }

      const translations = new Map(response.translations.map(({ id, text }) => [String(id), text]));
      const result = await applyBatchTranslations(batch, translations, batchRevision);

      if (result.cancelled) {
        return;
      }

      state.apiItems += Number(response.apiItems || 0);
      state.cacheEntries = Number.isFinite(Number(response.cacheEntries))
        ? Number(response.cacheEntries)
        : state.cacheEntries;
      state.cacheHits += Number(response.cacheHits || 0);
      state.translatedElements += result.applied;

    } catch (error) {
      const message = String(error?.message || error || "Translation failed.");

      if (batchRevision !== revision || message.includes("Translation request cancelled")) {
        return;
      }

      if (message.startsWith("Translation request queue")) {
        needsFullRescan = true;
        queueBackoffUntil = Date.now() + QUEUE_BACKOFF_MS;
      } else {
        state.error = message;
        clearPending();
        pauseObserver();
      }
    } finally {
      pendingTranslationMotions.delete(motionId);
      motion.finish();
      await releaseBatchTargets(batch);

      activeBatchCount = Math.max(0, activeBatchCount - 1);
      activeOffscreenBatchCount = Math.max(0, activeOffscreenBatchCount - (offscreen ? 1 : 0));
      state.translating = isTranslationViewActive() && activeBatchCount > 0;
      reportStatus();

      if (isTranslationViewActive() && pendingSegments.size > 0) {
        scheduleFlush();
      } else if (isTranslationViewActive() && activeBatchCount === 0 && needsFullRescan) {
        scheduleRecoveryScan();
      }
    }
  }

  function drainPending() {
    flushTimer = undefined;
    flushIdleHandle = undefined;
    flushScheduledForOffscreen = false;

    if (activeBrandScanCount > 0) {
      return;
    }

    while (isTranslationViewActive()
      && activeBatchCount < MAX_PARALLEL_BATCHES
      && pendingSegments.size > 0) {
      let batch = takeBatch(true);
      let offscreen = false;

      if (batch.length === 0) {
        if (activeOffscreenBatchCount >= 1) {
          break;
        }

        batch = takeBatch();
        offscreen = true;
      }

      if (batch.length === 0) {
        break;
      }

      void processBatch(batch, offscreen);
    }
  }

  function cancelScheduledFlush() {
    clearTimeout(flushTimer);
    flushTimer = undefined;

    if (flushIdleHandle !== undefined && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(flushIdleHandle);
    }

    flushIdleHandle = undefined;
    flushScheduledForOffscreen = false;
  }

  function scheduleFlush() {
    if (!isTranslationViewActive()
      || activeBrandScanCount > 0
      || activeBatchCount >= MAX_PARALLEL_BATCHES
      || pendingSegments.size === 0) {
      return;
    }

    const queueDelay = Math.max(0, queueBackoffUntil - Date.now());

    if (visiblePendingCounts.size > 0) {
      if (flushTimer) {
        if (!flushScheduledForOffscreen) {
          return;
        }

        clearTimeout(flushTimer);
        flushTimer = undefined;
        flushScheduledForOffscreen = false;
      }

      if (flushIdleHandle !== undefined && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(flushIdleHandle);
        flushIdleHandle = undefined;
      }

      flushScheduledForOffscreen = false;
      flushTimer = setTimeout(drainPending, Math.max(24, queueDelay));
      return;
    }

    if (activeOffscreenBatchCount >= 1 || flushTimer || flushIdleHandle !== undefined) {
      return;
    }

    const delay = Math.max(OFFSCREEN_BATCH_DELAY, queueDelay);

    if (typeof requestIdleCallback === "function") {
      flushIdleHandle = requestIdleCallback(drainPending, { timeout: delay });
    } else {
      flushScheduledForOffscreen = true;
      flushTimer = setTimeout(drainPending, delay);
    }
  }

  function cancelActiveTranslations() {
    translationCancellationPromise = translationCancellationPromise
      .then(() => api.runtime.sendMessage({ type: "cancelTranslations" }))
      .catch(() => undefined);
  }

  function clearPending() {
    cancelActiveTranslations();
    activeBrandScanCount = 0;
    pendingSegments.clear();
    pendingTargetCount = 0;
    pendingScanRootRefs.clear();
    pendingScanRootLookup = new WeakMap();
    subtreeScanJobs.length = 0;
    subtreeScanJobLookup = new WeakMap();
    visiblePendingCounts.clear();
    visibilityObserver?.disconnect();
    visibilityElementRefs.clear();
    visibilityElementLookup = new WeakMap();
    needsFullRescan = false;
    queuedTextNodes = new WeakSet();
    queuedAttributes = new WeakMap();
    documentRescanRequested = false;
    documentScanInProgress = false;
    clearTimeout(documentScanTimer);
    clearTimeout(cleanupTimer);
    clearTimeout(scanTimer);
    clearTimeout(subtreeScanTimer);
    cancelScheduledFlush();
    clearTimeout(recoveryScanTimer);
    clearTimeout(routePolicyTimer);
    clearTimeout(routeScanTimer);
    documentScanTimer = undefined;
    cleanupJob = undefined;
    cleanupRequested = false;
    cleanupTimer = undefined;
    scanTimer = undefined;
    subtreeScanTimer = undefined;
    recoveryScanTimer = undefined;
    routePolicyTimer = undefined;
    routeScanTimer = undefined;
    queueBackoffUntil = 0;
    removeMotion();
  }

  function removeMotion() {
    motionHost?.remove();
    motionHost = undefined;
    motionRoot = undefined;
    activeMotionElementCount = 0;
  }

  function processNextRestoreItem(job) {
    while (job.phaseIndex < job.phases.length) {
      const phase = job.phases[job.phaseIndex];

      if (phase.remaining <= 0) {
        job.phaseIndex += 1;
        continue;
      }

      const next = phase.iterator.next();
      phase.remaining -= 1;

      if (next.done) {
        job.phaseIndex += 1;
        continue;
      }

      if (phase.type === "text") {
        const reference = next.value;
        const node = reference.deref();
        const record = node ? textRecords.get(node) : null;

        if (node?.isConnected && record && node.nodeValue === record.displayed) {
          node.nodeValue = record.original;
        }

        trackedTextRefs.delete(reference);
      } else {
        const record = next.value;
        const element = record.element.deref();

        if (element?.isConnected && element.getAttribute(record.attribute) === record.displayed) {
          if (record.original === null) {
            element.removeAttribute(record.attribute);
          } else {
            element.setAttribute(record.attribute, record.original);
          }
        }

        trackedAttributeRecords.delete(record);
      }

      return true;
    }

    return false;
  }

  function finishRestore() {
    const resolve = restoreJob.resolve;
    restoreJob = undefined;
    textRecords = new WeakMap();
    trackedTextLookup = new WeakMap();
    attributeRecords = new WeakMap();
    trackedTextRefs.clear();
    trackedAttributeRecords.clear();
    state.apiItems = 0;
    state.cacheHits = 0;
    state.error = "";
    state.translatedElements = 0;
    state.translating = false;
    resumeObserver();
    removeMotion();
    reportStatus();
    resolve();
  }

  function runRestoreSlice() {
    const startedAt = performance.now();
    let processed = 0;

    while (processed < MAX_RESTORE_ITEMS_PER_SLICE
      && performance.now() - startedAt < SCAN_TIME_BUDGET_MS
      && processNextRestoreItem(restoreJob)) {
      processed += 1;
    }

    if (restoreJob.phaseIndex < restoreJob.phases.length) {
      setTimeout(runRestoreSlice, 0);
      return;
    }

    finishRestore();
  }

  function restorePage() {
    if (restoreJob) {
      return restoreJob.promise;
    }

    revision += 1;
    clearPending();
    pauseObserver();
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    restoreJob = {
      phaseIndex: 0,
      phases: [
        { iterator: trackedTextRefs.values(), remaining: trackedTextRefs.size, type: "text" },
        { iterator: trackedAttributeRecords.values(), remaining: trackedAttributeRecords.size, type: "attribute" }
      ],
      promise,
      resolve
    };
    runRestoreSlice();
    return promise;
  }

  function getDeclaredLanguage() {
    return normalizeLanguageCode(document.documentElement?.getAttribute("lang") || "");
  }

  async function getLanguageSample() {
    const chunks = [];
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    let characters = 0;
    let node = walker.nextNode();
    let visitedNodes = 0;

    while (node && characters < 5000 && visitedNodes < MAX_LANGUAGE_SAMPLE_NODES) {
      const startedAt = performance.now();
      let processed = 0;

      while (node
        && characters < 5000
        && visitedNodes < MAX_LANGUAGE_SAMPLE_NODES
        && processed < MAX_DOCUMENT_SCAN_NODES_PER_SLICE
        && performance.now() - startedAt < SCAN_TIME_BUDGET_MS) {
        if (node.parentElement && !isBlockedElement(node.parentElement)) {
          const text = normalizeText(resolveOriginalText(node.nodeValue, textRecords.get(node)));

          if (shouldTranslateText(text)) {
            chunks.push(text);
            characters += text.length;
          }
        }

        node = walker.nextNode();
        processed += 1;
        visitedNodes += 1;
      }

      if (node && characters < 5000 && visitedNodes < MAX_LANGUAGE_SAMPLE_NODES) {
        await yieldToPage();
      }
    }

    return chunks.join(" ").slice(0, 5000);
  }

  async function detectPageLanguage() {
    const declared = getDeclaredLanguage();
    const sample = await getLanguageSample();

    if (sample.length < 80) {
      return declared;
    }

    try {
      const result = await api.runtime.sendMessage({ type: "detectLanguage", text: sample });
      const detected = normalizeLanguageCode(result?.languages?.[0]?.language);
      const percentage = Number(result?.languages?.[0]?.percentage || 0);
      return detected && (result?.isReliable || percentage >= 50) ? detected : declared || detected;
    } catch {
      return declared;
    }
  }

  function updateRouteMonitoring() {
    const shouldMonitor = !state.error
      && window.top === window
      && document.visibilityState === "visible"
      && (state.enabled || (state.siteMode === "auto" && state.autoTranslateLanguages.length > 0));

    if (shouldMonitor && !routePollTimer) {
      routePollTimer = setInterval(checkRouteChange, 1000);
    } else if (!shouldMonitor && routePollTimer) {
      clearInterval(routePollTimer);
      routePollTimer = undefined;
    }
  }

  function finishRouteRescan(startedTranslation) {
    if (startedTranslation === undefined || !routeRescanPending) {
      return;
    }

    routeRescanPending = false;

    if (startedTranslation === false && isTranslationViewActive()) {
      scanSubtree(document);
    }
  }

  async function applySettings(settings, enabled, detectedLanguage, siteMode, nextPolicyRevision) {
    if (viewSwitchJob) {
      await viewSwitchJob.promise;
    }

    if (restoreJob) {
      await restoreJob.promise;
    }

    if (nextPolicyRevision !== policyRevision) {
      return undefined;
    }

    const provider = String(settings?.provider || state.provider);
    const next = {
      animationEnabled: settings?.animationEnabled !== false,
      autoTranslateLanguages: Array.isArray(settings?.autoTranslateLanguages) ? settings.autoTranslateLanguages : [],
      detectedLanguage: normalizeLanguageCode(detectedLanguage),
      enabled: Boolean(enabled),
      model: String(settings?.model || settings?.providerModels?.[provider] || state.model),
      preferredViewMode: ["bilingual", "translated"].includes(settings?.viewMode)
        ? settings.viewMode
        : "translated",
      provider,
      protectedTerms: Array.isArray(settings?.protectedTerms) ? settings.protectedTerms : [],
      siteMode,
      sourceLanguage: String(settings?.sourceLanguage || state.sourceLanguage),
      targetLanguage: String(settings?.targetLanguage || state.targetLanguage)
    };
    const translationChanged = next.model !== state.model
      || next.provider !== state.provider
      || next.protectedTerms.join("\u0000") !== state.protectedTerms.join("\u0000")
      || next.sourceLanguage !== state.sourceLanguage
      || next.targetLanguage !== state.targetLanguage;
    const preferredViewModeChanged = next.preferredViewMode !== state.preferredViewMode;
    const wasEnabled = state.enabled;

    if (wasEnabled && (!next.enabled || translationChanged)) {
      state.enabled = false;
      await restorePage();

      if (nextPolicyRevision !== policyRevision) {
        return undefined;
      }
    }

    state.animationEnabled = next.animationEnabled;

    if (!next.animationEnabled) {
      removeMotion();
    }

    state.autoTranslateLanguages = next.autoTranslateLanguages;
    state.detectedLanguage = next.detectedLanguage;
    state.enabled = next.enabled;
    state.model = next.model;
    state.preferredViewMode = next.preferredViewMode;
    state.provider = next.provider;
    state.protectedTerms = next.protectedTerms;
    state.siteMode = next.siteMode;
    state.sourceLanguage = next.sourceLanguage;
    state.targetLanguage = next.targetLanguage;

    if (!next.enabled || !wasEnabled) {
      state.viewMode = next.preferredViewMode;
      lastActiveViewMode = next.preferredViewMode;
    } else if (preferredViewModeChanged) {
      lastActiveViewMode = next.preferredViewMode;

      if (state.viewMode !== "original") {
        await showActiveView(next.preferredViewMode);

        if (nextPolicyRevision !== policyRevision) {
          return undefined;
        }
      }
    }

    const startTranslation = shouldStartTranslation({
      enabled: next.enabled,
      error: state.error,
      translationChanged,
      wasEnabled
    });

    if (startTranslation || !next.enabled) {
      state.error = "";
    }

    updateRouteMonitoring();

    if (isTranslationViewActive()) {
      resumeObserver();
    } else {
      pauseObserver();
    }

    if (startTranslation && ["bilingual", "translated"].includes(state.viewMode)) {
      scanSubtree(document);
    }

    reportStatus();
    return startTranslation;
  }

  async function applyPolicy(settings, providedSiteMode) {
    const nextPolicyRevision = ++policyRevision;
    const siteMode = providedSiteMode || settings?.siteRules?.[site] || "auto";
    const declaredLanguage = getDeclaredLanguage();
    let detectedLanguage = declaredLanguage;

    currentSettings = settings || {};

    if (shouldDetectPageLanguage({
      declaredLanguage,
      selectedLanguages: settings?.autoTranslateLanguages,
      siteMode,
      sourceLanguage: settings?.sourceLanguage,
      targetLanguage: settings?.targetLanguage
    })) {
      detectedLanguage = await detectPageLanguage();
    }

    if (nextPolicyRevision !== policyRevision) {
      return undefined;
    }

    const enabled = siteMode === "always"
      || (siteMode === "auto" && shouldAutoTranslateLanguage(
        detectedLanguage,
        settings?.autoTranslateLanguages,
        settings?.targetLanguage
      ));
    return applySettings(settings, enabled, detectedLanguage, siteMode, nextPolicyRevision);
  }

  async function refreshPolicy() {
    const refreshRevision = ++settingsRefreshRevision;
    policyRevision += 1;
    clearTimeout(routePolicyTimer);
    clearTimeout(routeScanTimer);
    routePolicyTimer = undefined;
    routeScanTimer = undefined;

    try {
      const response = await api.runtime.sendMessage({ type: "getSettings", site });

      if (refreshRevision !== settingsRefreshRevision) {
        return;
      }

      const startedTranslation = await applyPolicy(response.settings, response.siteMode);
      finishRouteRescan(startedTranslation);
    } catch (error) {
      if (refreshRevision !== settingsRefreshRevision) {
        return;
      }

      state.error = String(error?.message || error || "Could not load extension settings.");
      revision += 1;
      clearPending();
      pauseObserver();
      updateRouteMonitoring();
      reportStatus();
    }
  }

  function checkRouteChange() {
    if (location.href === currentUrl) {
      return false;
    }

    currentUrl = location.href;
    policyRevision += 1;
    revision += 1;
    closeSelectionUi();
    clearPending();
    routeRescanPending = true;
    brandTerms.clear();
    wholeBrandTerms.clear();
    refreshPageBrandTerms();
    scheduleCleanup(0);
    state.error = "";
    updateRouteMonitoring();

    if (shouldRefreshRoutePolicy(state.siteMode, state.sourceLanguage)) {
      pauseObserver();
      routePolicyTimer = setTimeout(() => {
        routePolicyTimer = undefined;
        void applyPolicy(currentSettings, state.siteMode).then(finishRouteRescan);
      }, 380);
    } else if (isTranslationViewActive()) {
      resumeObserver();
      routeScanTimer = setTimeout(() => {
        routeScanTimer = undefined;
        finishRouteRescan(false);
      }, 40);
    } else {
      routeRescanPending = false;
    }

    reportStatus();
    return true;
  }

  function handleVisibilityChange() {
    updateRouteMonitoring();

    if (document.visibilityState !== "visible") {
      removeMotion();
      return;
    }

    checkRouteChange();

    if (isTranslationViewActive()) {
      scheduleScan(document);
    }
  }

  function handleViewportMovement() {
    closeSelectionUi();

    if (activeMotionElementCount > 0) {
      removeMotion();
    }
  }

  function processNextViewSwitchItem(job) {
    while (job.phaseIndex < job.phases.length) {
      const phase = job.phases[job.phaseIndex];

      if (phase.remaining <= 0) {
        job.phaseIndex += 1;
        continue;
      }

      const next = phase.iterator.next();
      phase.remaining -= 1;

      if (next.done) {
        phase.remaining = 0;
        job.phaseIndex += 1;
        continue;
      }

      if (phase.type === "text") {
        const reference = next.value;
        const node = reference.deref();
        const record = node ? textRecords.get(node) : null;

        if (!node?.isConnected || !record) {
          continue;
        }

        if (node.nodeValue !== record.displayed) {
          scheduleScan(node);
          continue;
        }

        record.displayed = getDisplayedText(record, job.viewMode);
        node.nodeValue = record.displayed;
        return true;
      }

      const record = next.value;
      const element = record.element.deref();

      if (!element?.isConnected) {
        continue;
      }

      if (element.getAttribute(record.attribute) !== record.displayed) {
        scheduleScan(element);
        continue;
      }

      record.displayed = getDisplayedAttribute(record, job.viewMode);

      if (record.displayed === null) {
        element.removeAttribute(record.attribute);
      } else {
        element.setAttribute(record.attribute, record.displayed);
      }

      return true;
    }

    return false;
  }

  function finishViewSwitch() {
    const resolve = viewSwitchJob.resolve;
    viewSwitchJob = undefined;
    resumeObserver();
    scanSubtree(document);
    scheduleCleanup();
    reportStatus();
    resolve();
  }

  function runViewSwitchSlice() {
    const startedAt = performance.now();
    let processed = 0;

    while (processed < MAX_VIEW_SWITCH_ITEMS_PER_SLICE
      && performance.now() - startedAt < SCAN_TIME_BUDGET_MS
      && processNextViewSwitchItem(viewSwitchJob)) {
      processed += 1;
    }

    if (viewSwitchJob.phaseIndex < viewSwitchJob.phases.length) {
      setTimeout(runViewSwitchSlice, 0);
      return;
    }

    finishViewSwitch();
  }

  async function showActiveView(viewMode) {
    if (viewSwitchJob) {
      await viewSwitchJob.promise;
    }

    if (restoreJob) {
      await restoreJob.promise;
    }

    if (!state.enabled || !["bilingual", "original", "translated"].includes(viewMode)) {
      return publicStatus();
    }

    if (state.viewMode === viewMode) {
      return publicStatus();
    }

    if (viewMode !== "original") {
      lastActiveViewMode = viewMode;
    }

    state.error = "";
    state.viewMode = viewMode;
    pauseObserver();
    removeMotion();
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    viewSwitchJob = {
      phaseIndex: 0,
      phases: [
        { iterator: trackedTextRefs.values(), remaining: trackedTextRefs.size, type: "text" },
        {
          iterator: trackedAttributeRecords.values(),
          remaining: trackedAttributeRecords.size,
          type: "attribute"
        }
      ],
      promise,
      resolve,
      viewMode
    };

    if (viewSwitchJob.phases.some(({ remaining }) => remaining > 0)) {
      runViewSwitchSlice();
      await promise;
    } else {
      finishViewSwitch();
    }

    return publicStatus();
  }

  async function showOriginal() {
    return showActiveView("original");
  }

  async function showTranslation() {
    return showActiveView("translated");
  }

  async function showBilingual() {
    return showActiveView("bilingual");
  }

  async function enableTranslation(viewMode = lastActiveViewMode) {
    if (viewSwitchJob) {
      await viewSwitchJob.promise;
    }

    if (restoreJob) {
      await restoreJob.promise;
    }

    state.error = "";
    state.enabled = true;
    state.siteMode = "session";
    state.viewMode = viewMode;
    lastActiveViewMode = viewMode;
    routeRescanPending = false;
    updateRouteMonitoring();
    resumeObserver();
    scanSubtree(document);
    reportStatus();
    return publicStatus();
  }

  function destroySelectionUi() {
    selectionHost?.remove();
    selectionHost = undefined;
    selectionRoot = undefined;
  }

  function closeSelectionUi() {
    selectionRequestRevision += 1;
    destroySelectionUi();
  }

  function ensureSelectionRoot() {
    if (selectionHost?.isConnected && selectionRoot) {
      return selectionRoot;
    }

    selectionHost = document.createElement("div");
    selectionHost.setAttribute("data-no-translate", "");
    selectionHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:auto;";
    selectionRoot = selectionHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; color-scheme: light dark; }
      .card {
        width: min(320px, calc(100vw - 16px));
        overflow: hidden;
        border: 1px solid rgba(60, 60, 67, .18);
        border-radius: 14px;
        color: #1d1d1f;
        background: rgba(255, 255, 255, .94);
        box-shadow: 0 16px 46px rgba(0, 0, 0, .2);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(20px) saturate(1.2);
      }
      .action {
        width: 100%;
        min-height: 40px;
        padding: 0 15px;
        border: 0;
        color: #fff;
        background: #087af0;
        cursor: pointer;
        font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .body { display: grid; gap: 10px; padding: 13px 15px 15px; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .title { font-weight: 750; }
      .close {
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        color: rgba(29, 29, 31, .68);
        background: rgba(60, 60, 67, .1);
        cursor: pointer;
        font: 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .label {
        margin-bottom: 3px;
        color: rgba(29, 29, 31, .58);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      .text { max-height: 132px; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
      .original { color: rgba(29, 29, 31, .68); }
      .error { color: #c9344a; }
      @media (prefers-color-scheme: dark) {
        .card {
          border-color: rgba(255, 255, 255, .18);
          color: #f5f5f7;
          background: rgba(35, 35, 38, .94);
        }
        .close {
          color: rgba(245, 245, 247, .72);
          background: rgba(255, 255, 255, .1);
        }
        .label { color: rgba(245, 245, 247, .62); }
        .original { color: rgba(245, 245, 247, .72); }
      }
      @media (prefers-reduced-motion: no-preference) {
        .card { animation: arrive 180ms cubic-bezier(.22, 1, .36, 1) both; }
        @keyframes arrive {
          from { opacity: 0; transform: translate3d(0, 4px, 0) scale(.98); }
          to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
        }
      }
    `;
    selectionRoot.append(style);
    document.documentElement.append(selectionHost);
    return selectionRoot;
  }

  function positionSelectionUi(rectangle) {
    if (!selectionHost) {
      return;
    }

    const width = Math.max(0, Math.min(320, window.innerWidth - 16));
    const left = Math.min(
      Math.max(8, Number(rectangle?.left) || window.innerWidth / 2 - width / 2),
      Math.max(8, window.innerWidth - width - 8)
    );
    const below = (Number(rectangle?.bottom) || window.innerHeight / 2) + 8;
    const top = below + 180 <= window.innerHeight
      ? below
      : Math.max(8, (Number(rectangle?.top) || window.innerHeight / 2) - 188);
    selectionHost.style.left = `${left}px`;
    selectionHost.style.top = `${top}px`;
  }

  function createSelectionCard(rectangle, title) {
    const root = ensureSelectionRoot();
    const card = document.createElement("section");
    const body = document.createElement("div");
    const header = document.createElement("div");
    const heading = document.createElement("strong");
    const closeButton = document.createElement("button");
    card.className = "card";
    body.className = "body";
    header.className = "header";
    heading.className = "title";
    heading.textContent = title;
    closeButton.className = "close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", t("close", null, "Close"));
    closeButton.textContent = "×";
    closeButton.addEventListener("click", closeSelectionUi);
    header.append(heading, closeButton);
    body.append(header);
    card.append(body);
    root.replaceChildren(root.querySelector("style"), card);
    positionSelectionUi(rectangle);
    return body;
  }

  function appendSelectionText(body, label, text, className = "") {
    const section = document.createElement("div");
    const heading = document.createElement("div");
    const content = document.createElement("div");
    heading.className = "label";
    heading.textContent = label;
    content.className = `text ${className}`.trim();
    content.textContent = text;
    section.append(heading, content);
    body.append(section);
  }

  function getSelectionDetails(preferredText = "") {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const commonNode = range?.commonAncestorContainer;
    const commonElement = commonNode?.nodeType === Node.ELEMENT_NODE
      ? commonNode
      : commonNode?.parentElement;

    if (commonElement && (isEditableElement(commonElement) || isBlockedElement(commonElement))) {
      return null;
    }

    const text = String(preferredText || selection?.toString() || "").trim();

    if (!shouldTranslateText(text)) {
      return null;
    }

    let rectangle;

    try {
      rectangle = range?.getBoundingClientRect();
    } catch {
      rectangle = undefined;
    }

    return { rectangle, text };
  }

  function showSelectionError(details, message) {
    const body = createSelectionCard(
      details?.rectangle,
      t("translationStopped", null, "Translation stopped")
    );
    const error = document.createElement("div");
    error.className = "text error";
    error.textContent = message;
    body.append(error);
  }

  async function translateSelection(details) {
    if (details.text.length > MAX_SELECTION_CHARACTERS) {
      showSelectionError(
        details,
        t("selectionTooLong", null, "Select no more than 4,000 characters.")
      );
      return;
    }

    const requestRevision = ++selectionRequestRevision;
    const loadingBody = createSelectionCard(
      details.rectangle,
      t("selectionTranslating", null, "Translating selection…")
    );
    appendSelectionText(
      loadingBody,
      t("selectionOriginal", null, "Original"),
      details.text,
      "original"
    );
    const { terms, wholeTerms } = getProtectedTermSets();

    try {
      const response = await api.runtime.sendMessage({
        type: "translateBatch",
        sourceLanguage: resolveRequestSourceLanguage(state.sourceLanguage),
        items: [{
          id: "selection",
          text: details.text,
          context: addPageLanguageContext(
            "selection",
            state.sourceLanguage === "auto" ? state.detectedLanguage : ""
          ),
          kind: "text",
          protectedTerms: selectProtectedTerms(details.text, terms, "text", wholeTerms)
            .slice(0, MAX_PROTECTED_TERMS_PER_ITEM)
        }]
      });

      if (requestRevision !== selectionRequestRevision || !selectionHost?.isConnected) {
        return;
      }

      const translated = response.translations?.find(({ id }) => id === "selection")?.text;

      if (typeof translated !== "string") {
        throw new Error("The translation response did not include the selected text.");
      }

      state.apiItems += Number(response.apiItems || 0);
      state.cacheEntries = Number.isFinite(Number(response.cacheEntries))
        ? Number(response.cacheEntries)
        : state.cacheEntries;
      state.cacheHits += Number(response.cacheHits || 0);
      reportStatus();
      const body = createSelectionCard(
        details.rectangle,
        t("selectionTranslation", null, "Translation")
      );
      appendSelectionText(
        body,
        t("selectionOriginal", null, "Original"),
        details.text,
        "original"
      );
      appendSelectionText(
        body,
        t("selectionTranslation", null, "Translation"),
        translated
      );
    } catch (error) {
      if (requestRevision === selectionRequestRevision) {
        showSelectionError(details, String(error?.message || error));
      }
    }
  }

  function getDeepActiveElement() {
    let activeElement = document.activeElement;

    while (activeElement?.shadowRoot?.activeElement) {
      activeElement = activeElement.shadowRoot.activeElement;
    }

    return activeElement;
  }

  function hasFocusedChildFrame() {
    return ["FRAME", "IFRAME"].includes(getDeepActiveElement()?.tagName);
  }

  function createInputEvent(text) {
    try {
      return new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText"
      });
    } catch {
      return new Event("input", { bubbles: true });
    }
  }

  function isRangeInsideElement(range, element) {
    const container = range?.commonAncestorContainer;
    return Boolean(container?.isConnected && element?.contains(container));
  }

  function getEditableTranslationTarget() {
    const activeElement = getDeepActiveElement();

    if (activeElement?.tagName === "INPUT" || activeElement?.tagName === "TEXTAREA") {
      const inputType = String(activeElement.type || "text").toLowerCase();

      if (activeElement.tagName === "INPUT" && !["search", "text"].includes(inputType)) {
        return null;
      }

      const originalValue = activeElement.value;
      const selectionStart = Number.isInteger(activeElement.selectionStart)
        ? activeElement.selectionStart
        : 0;
      const selectionEnd = Number.isInteger(activeElement.selectionEnd)
        ? activeElement.selectionEnd
        : originalValue.length;
      const hasSelection = selectionEnd > selectionStart;
      const selectedText = hasSelection
        ? originalValue.slice(selectionStart, selectionEnd)
        : originalValue;
      const boundary = splitBoundaryWhitespace(selectedText);
      const text = boundary.core;

      if (!shouldTranslateText(text)) {
        return null;
      }

      return {
        apply(translation) {
          if (!activeElement.isConnected || activeElement.value !== originalValue) {
            return false;
          }

          const start = hasSelection ? selectionStart : 0;
          const end = hasSelection ? selectionEnd : originalValue.length;
          const replacement = `${boundary.leading}${translation}${boundary.trailing}`;
          activeElement.setRangeText(replacement, start, end, "end");
          activeElement.dispatchEvent(createInputEvent(replacement));
          return true;
        },
        rectangle: activeElement.getBoundingClientRect(),
        text
      };
    }

    if (!activeElement?.isContentEditable) {
      return null;
    }

    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectedText = String(range?.toString() || "");
    const boundary = splitBoundaryWhitespace(selectedText);
    const text = boundary.core;

    if (!range
      || range.collapsed
      || !isRangeInsideElement(range, activeElement)
      || range.startContainer !== range.endContainer
      || range.startContainer.nodeType !== Node.TEXT_NODE
      || !shouldTranslateText(text)) {
      return null;
    }

    const textNode = range.startContainer;
    const originalValue = textNode.nodeValue ?? "";
    const selectionStart = range.startOffset;
    const selectionEnd = range.endOffset;

    return {
      apply(translation) {
        if (!activeElement.isConnected
          || !textNode.isConnected
          || !activeElement.contains(textNode)
          || textNode.nodeValue !== originalValue) {
          return false;
        }

        const replacement = `${boundary.leading}${translation}${boundary.trailing}`;
        textNode.nodeValue = `${originalValue.slice(0, selectionStart)}${replacement}${originalValue.slice(selectionEnd)}`;
        const nextRange = document.createRange();
        nextRange.setStart(textNode, selectionStart + replacement.length);
        nextRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(nextRange);
        activeElement.dispatchEvent(createInputEvent(replacement));
        return true;
      },
      rectangle: range.getBoundingClientRect(),
      text
    };
  }

  async function translateEditable({ silentIfUnavailable = false } = {}) {
    const target = getEditableTranslationTarget();

    if (!target) {
      if (!silentIfUnavailable) {
        showSelectionError(
          null,
          t(
            "editableSelectionRequired",
            null,
            "Focus a text field, or select text inside a rich editor, then try again."
          )
        );
      }

      return;
    }

    if (target.text.length > MAX_SELECTION_CHARACTERS) {
      showSelectionError(
        { rectangle: target.rectangle },
        t("selectionTooLong", null, "Select no more than 4,000 characters.")
      );
      return;
    }

    const requestRevision = ++selectionRequestRevision;
    const loadingBody = createSelectionCard(
      target.rectangle,
      t("editableTranslating", null, "Translating field…")
    );
    appendSelectionText(
      loadingBody,
      t("selectionOriginal", null, "Original"),
      target.text,
      "original"
    );

    try {
      const response = await api.runtime.sendMessage({
        type: "translateBatch",
        persistCache: false,
        sourceLanguage: resolveRequestSourceLanguage(state.sourceLanguage),
        items: [{
          id: "editable",
          text: target.text,
          context: addPageLanguageContext(
            "User explicitly requested translation for an editable field",
            state.sourceLanguage === "auto" ? state.detectedLanguage : ""
          ),
          kind: "editable",
          protectedTerms: []
        }]
      });

      if (requestRevision !== selectionRequestRevision || !selectionHost?.isConnected) {
        return;
      }

      const translated = response.translations?.find(({ id }) => id === "editable")?.text;

      if (typeof translated !== "string") {
        throw new Error("The translation response did not include the editable text.");
      }

      if (!target.apply(translated)) {
        throw new Error(
          t(
            "editableChanged",
            null,
            "The field changed while translation was running, so it was not overwritten."
          )
        );
      }

      state.apiItems += Number(response.apiItems || 0);
      reportStatus();
      const body = createSelectionCard(
        target.rectangle,
        t("editableTranslated", null, "Field translated")
      );
      appendSelectionText(
        body,
        t("selectionTranslation", null, "Translation"),
        translated
      );
    } catch (error) {
      if (requestRevision === selectionRequestRevision) {
        showSelectionError(
          { rectangle: target.rectangle },
          String(error?.message || error)
        );
      }
    }
  }

  function showSelectionAction(details) {
    selectionRequestRevision += 1;
    const root = ensureSelectionRoot();
    const button = document.createElement("button");
    button.className = "action";
    button.type = "button";
    button.textContent = t("translateSelection", null, "Translate");
    button.addEventListener("click", () => void translateSelection(details), { once: true });
    root.replaceChildren(root.querySelector("style"), button);
    positionSelectionUi(details.rectangle);
  }

  function handleSelectionPointerUp(event) {
    if (selectionHost && event.composedPath().includes(selectionHost)) {
      return;
    }

    setTimeout(() => {
      const details = getSelectionDetails();

      if (details) {
        showSelectionAction(details);
      }
    }, 0);
  }

  function handleSelectionPointerDown(event) {
    if (selectionHost && !event.composedPath().includes(selectionHost)) {
      closeSelectionUi();
    }
  }

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "translationMotionStart") {
      pendingTranslationMotions.get(String(message.motionId || ""))?.start();
      return Promise.resolve();
    }

    if (message?.type === "getStatus") {
      return Promise.resolve(publicStatus());
    }

    if (message?.type === "translateNow") {
      return enableTranslation();
    }

    if (message?.type === "toggleTranslation") {
      if (!state.enabled) {
        return enableTranslation();
      }

      return state.viewMode === "original"
        ? showActiveView(lastActiveViewMode)
        : showOriginal();
    }

    if (message?.type === "cycleViewMode") {
      if (!state.enabled) {
        return enableTranslation();
      }

      if (state.viewMode === "original") {
        return showTranslation();
      }

      return state.viewMode === "translated" ? showBilingual() : showOriginal();
    }

    if (message?.type === "restoreNow" || message?.type === "showOriginal") {
      return showOriginal();
    }

    if (message?.type === "showTranslation") {
      return showTranslation();
    }

    if (message?.type === "showBilingual") {
      return showBilingual();
    }

    if (message?.type === "translateSelection") {
      const details = getSelectionDetails(message.text);

      if (details) {
        void translateSelection(details);
      }

      return Promise.resolve();
    }

    if (message?.type === "translateEditable") {
      if (document.hasFocus()) {
        void translateEditable({ silentIfUnavailable: hasFocusedChildFrame() });
      }

      return Promise.resolve();
    }

    if (message?.type === "settingsChanged") {
      void refreshPolicy();
      return Promise.resolve(publicStatus());
    }

    return undefined;
  });

  window.addEventListener("hashchange", checkRouteChange);
  window.addEventListener("pagehide", () => {
    closeSelectionUi();
    cancelActiveTranslations();
  });
  window.addEventListener("popstate", checkRouteChange);

  window.addEventListener("resize", handleViewportMovement, { passive: true });
  window.addEventListener("scroll", handleViewportMovement, { capture: true, passive: true });

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("pointerdown", handleSelectionPointerDown, true);
  document.addEventListener("pointerup", handleSelectionPointerUp, true);
  observeRoot(document);
  void refreshPolicy();
})();
