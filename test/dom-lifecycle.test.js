const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createProtectedTermIndex,
  discoverOpenShadowRoots,
  discoverOpenShadowRootsAcrossReferences,
  getPageContextChange,
  getPendingQueueDecision,
  getShadowDiscoveryDelay,
  getUtf8ByteLength,
  hasMeaningfulText,
  isGuaranteedBlockedSubtree,
  isTextWithinLimits,
  isWithinTextBudget,
  isWhitespaceSensitiveElement,
  selectProtectedTerms,
  shouldPruneScanNode,
  shouldPreserveTextWhitespace,
  shouldRunShadowDiscovery,
  shouldRunShadowDiscoveryRetryRound,
  splitBoundaryWhitespace,
  splitTextForTranslation
} = require("../src/lib/dom-core.js");

function createElement({
  contentEditable = false,
  parentElement = null,
  tagName = "DIV",
  attributes = []
} = {}) {
  const attributeNames = new Set(attributes);

  return {
    getRootNode: () => ({ host: null }),
    hasAttribute: (name) => attributeNames.has(name),
    isContentEditable: contentEditable,
    parentElement,
    tagName
  };
}

test("reuses one compiled protected-term index across multiple items", () => {
  let iterations = 0;
  const terms = {
    *[Symbol.iterator]() {
      iterations += 1;
      yield "North Star";
      yield "AA";
    }
  };
  const index = createProtectedTermIndex(terms, ["North Star"]);

  assert.deepEqual(
    selectProtectedTerms("North Star milk", index, "product-title"),
    ["North Star"]
  );
  assert.deepEqual(
    selectProtectedTerms("AA batteries", index, "product-title"),
    ["AA"]
  );
  assert.equal(iterations, 1);
});

test("identifies only subtrees whose elements and attributes are both blocked", () => {
  const script = createElement({ tagName: "SCRIPT" });
  const editable = createElement({ contentEditable: true });
  const editableChild = createElement({
    contentEditable: true,
    parentElement: editable,
    tagName: "SPAN"
  });
  const optedOut = createElement({ attributes: ["data-no-translate"] });

  assert.equal(isGuaranteedBlockedSubtree(script), true);
  assert.equal(isGuaranteedBlockedSubtree(optedOut), true);
  assert.equal(isGuaranteedBlockedSubtree(editable), false);
  assert.equal(isGuaranteedBlockedSubtree(editableChild), true);
});

test("prunes blocked element subtrees without hiding individual text nodes from scan budgets", () => {
  const blockedElement = {
    ...createElement({ tagName: "SCRIPT" }),
    nodeType: 1
  };
  const formattingText = {
    nodeType: 3,
    nodeValue: "\n  ",
    parentElement: blockedElement
  };

  assert.equal(shouldPruneScanNode(blockedElement), true);
  assert.equal(shouldPruneScanNode(formattingText), false);
  assert.equal(shouldPruneScanNode({ ...createElement(), nodeType: 1 }), false);
});

test("detects semantic and computed whitespace-preserving regions", () => {
  const preformatted = {
    closest(selector) {
      return selector === "pre" ? this : null;
    }
  };
  const wrapped = { closest: () => null };
  const regular = { closest: () => null };
  let styleReads = 0;

  assert.equal(isWhitespaceSensitiveElement(preformatted, () => "normal"), true);
  assert.equal(isWhitespaceSensitiveElement(wrapped, () => "pre-wrap"), true);
  assert.equal(isWhitespaceSensitiveElement(wrapped, () => "pre-line"), true);
  assert.equal(isWhitespaceSensitiveElement(wrapped, () => "break-spaces"), true);
  assert.equal(isWhitespaceSensitiveElement(regular, () => "normal"), false);
  assert.equal(shouldPreserveTextWhitespace(preformatted, "One line", () => {
    styleReads += 1;
    return "pre-wrap";
  }), false);
  assert.equal(styleReads, 0);
  assert.equal(shouldPreserveTextWhitespace(preformatted, "First\nSecond", () => "normal"), true);
  assert.equal(shouldPreserveTextWhitespace(wrapped, "First  second", () => "pre-wrap"), true);
  assert.equal(shouldPreserveTextWhitespace(wrapped, "First\u00a0second", () => "pre-line"), true);
  assert.equal(shouldPreserveTextWhitespace(regular, "First\nSecond", () => "normal"), false);
});

test("preserves structural whitespace while splitting translatable prose", () => {
  const source = " \nFirst line\n  Second line\tThird  phrase\n ";
  const boundary = splitBoundaryWhitespace(source);
  const chunks = splitTextForTranslation(boundary.core, 8000, true);

  assert.deepEqual(chunks, [
    { separator: "\n  ", text: "First line" },
    { separator: "\t", text: "Second line" },
    { separator: "  ", text: "Third" },
    { separator: "", text: "phrase" }
  ]);
  assert.equal(
    `${boundary.leading}${
      chunks.map(({ separator }, index) => `${
        ["Первая строка", "Вторая строка", "Третья", "фраза"][index]
      }${separator}`).join("")
    }${boundary.trailing}`,
    " \nПервая строка\n  Вторая строка\tТретья  фраза\n "
  );
});

test("preserves structural whitespace when prose also exceeds the chunk limit", () => {
  const chunks = splitTextForTranslation("alpha beta gamma\nnext line", 10, true);

  assert.deepEqual(chunks, [
    { separator: " ", text: "alpha beta" },
    { separator: "\n", text: "gamma" },
    { separator: "", text: "next line" }
  ]);
});

test("bounds structural chunks and retries only until queue capacity is available", () => {
  const source = Array.from({ length: 6000 }, () => "x").join("\n");
  const chunks = splitTextForTranslation(source, 8000, true, 5000);
  const maximum = {
    bytes: 2_048_000,
    characters: 1_024_000,
    targets: 5000
  };
  const additional = {
    bytes: Buffer.byteLength(source),
    characters: source.length,
    targets: chunks.length
  };

  assert.equal(chunks.length, 5000);
  assert.equal(chunks.map(({ separator, text }) => `${text}${separator}`).join(""), source);
  assert.equal(getPendingQueueDecision({}, additional, maximum), "queue");
  assert.equal(
    getPendingQueueDecision({ bytes: 1, characters: 1, targets: 1 }, additional, maximum),
    "retry"
  );
  assert.equal(
    getPendingQueueDecision({}, { ...additional, targets: 5001 }, maximum),
    "reject"
  );
});

test("counts pending payload size in exact UTF-8 bytes", () => {
  assert.equal(getUtf8ByteLength("plain"), 5);
  assert.equal(getUtf8ByteLength("Перевод"), 14);
  assert.equal(getUtf8ByteLength("a😀b"), 6);
  assert.equal(getUtf8ByteLength("\uD800"), 3);
});

test("rejects formatting-only text before DOM style checks", () => {
  assert.equal(hasMeaningfulText(" \n\t\u00a0 "), false);
  assert.equal(hasMeaningfulText("\n  Product name  "), true);
});

test("enforces source and aggregate queue limits before work is retained", () => {
  assert.equal(isTextWithinLimits("short text", 20, 20), true);
  assert.equal(isTextWithinLimits("длинный текст", 20, 20), false);
  assert.equal(isTextWithinLimits("x".repeat(21), 20, 100), false);
  assert.equal(isWithinTextBudget(
    { bytes: 80, characters: 40 },
    { bytes: 21, characters: 10 },
    { bytes: 100, characters: 100 }
  ), false);
  assert.equal(isWithinTextBudget(
    { bytes: 80, characters: 40 },
    { bytes: 20, characters: 61 },
    { bytes: 100, characters: 100 }
  ), false);
});

test("detects a language-only SPA context change", () => {
  assert.deepEqual(
    getPageContextChange(
      "https://example.com/catalog",
      "pt-PT",
      "https://example.com/catalog",
      "en-US"
    ),
    {
      changed: true,
      languageChanged: true,
      urlChanged: false
    }
  );
  assert.equal(
    getPageContextChange(
      "https://example.com/catalog",
      "pt",
      "https://example.com/catalog",
      "pt-BR"
    ).changed,
    false
  );
});

test("discovers a late open shadow root through bounded follow-up scans", () => {
  const firstHost = { shadowRoot: null };
  const lateHost = { shadowRoot: null };
  const lastHost = { shadowRoot: null };
  const nodes = [firstHost, lateHost, lastHost];
  const createWalker = () => {
    let index = 0;

    return {
      nextNode() {
        const node = nodes[index];
        index += 1;
        return node || null;
      }
    };
  };
  const initiallyDiscovered = [];
  let result = discoverOpenShadowRoots(createWalker(), 2, (root) => initiallyDiscovered.push(root));

  assert.deepEqual(initiallyDiscovered, []);
  assert.deepEqual(result, { budgetUsed: 2, complete: false, processed: 2 });

  const shadowRoot = { host: lateHost };
  lateHost.shadowRoot = shadowRoot;
  const discovered = [];
  const walker = createWalker();

  result = discoverOpenShadowRoots(walker, 1, (root) => discovered.push(root));
  assert.deepEqual(result, { budgetUsed: 1, complete: false, processed: 1 });
  assert.deepEqual(discovered, []);

  result = discoverOpenShadowRoots(walker, 1, (root) => discovered.push(root));
  assert.deepEqual(result, { budgetUsed: 1, complete: false, processed: 1 });
  assert.deepEqual(discovered, [shadowRoot]);
});

test("bounds a discovery slice containing many zero-node shadow roots", () => {
  const roots = Array.from({ length: 1000 }, () => ({
    nextNode: () => null
  }));
  let remaining = 400;
  let visitedRoots = 0;

  while (remaining > 0 && visitedRoots < roots.length) {
    const result = discoverOpenShadowRoots(roots[visitedRoots], remaining, () => undefined);
    remaining -= result.budgetUsed;
    visitedRoots += 1;
  }

  assert.equal(visitedRoots, 400);
  assert.equal(remaining, 0);
});

test("shares one discovery slice fairly across large roots", () => {
  const firstRoot = {};
  const secondRoot = {};
  const discoveredRoot = {};
  const references = [firstRoot, secondRoot].map((root) => ({
    deref: () => root
  }));
  const secondNodes = [{ shadowRoot: discoveredRoot }, null];
  const walkers = new WeakMap();
  const result = discoverOpenShadowRootsAcrossReferences({
    createWalker(root) {
      return root === firstRoot
        ? { nextNode: () => ({ shadowRoot: null }) }
        : { nextNode: () => secondNodes.shift() };
    },
    isRootActive: () => true,
    iterator: references.values(),
    maximumWork: 4,
    referencesRemaining: references.length,
    visitRoot: (root) => assert.equal(root, discoveredRoot),
    walkers
  });

  assert.deepEqual(result, {
    complete: true,
    incomplete: true,
    incompleteReferences: [references[0]],
    processed: 3,
    referencesRemaining: 0
  });
  assert.equal(walkers.has(firstRoot), true);
  assert.equal(walkers.has(secondRoot), false);
});

test("bounds lazy shadow-root reference discovery before dereferencing every root", () => {
  let dereferences = 0;
  const references = Array.from({ length: 1000 }, () => ({
    deref() {
      dereferences += 1;
      return undefined;
    }
  }));
  const result = discoverOpenShadowRootsAcrossReferences({
    createWalker: () => {
      throw new Error("Dead roots must not create walkers.");
    },
    isRootActive: () => false,
    iterator: references.values(),
    maximumWork: 400,
    referencesRemaining: references.length,
    visitRoot: () => undefined,
    walkers: new WeakMap()
  });

  assert.deepEqual(result, {
    complete: false,
    incomplete: false,
    incompleteReferences: [],
    processed: 400,
    referencesRemaining: 600
  });
  assert.equal(dereferences, 400);
});

test("retries unfinished shadow-root walkers without rescanning completed roots", () => {
  const deepRoot = {};
  const completedRoots = Array.from({ length: 999 }, () => ({}));
  const references = [deepRoot, ...completedRoots].map((root) => ({
    deref: () => root
  }));
  const iterator = references.values();
  const walkers = new WeakMap();
  let deepNodesRemaining = 801;

  const createWalker = (root) => root === deepRoot
    ? {
      nextNode() {
        if (deepNodesRemaining === 0) {
          return null;
        }

        deepNodesRemaining -= 1;
        return {};
      }
    }
    : { nextNode: () => null };
  const run = (roundIterator, referencesRemaining, maximumWork = 400) => (
    discoverOpenShadowRootsAcrossReferences({
      createWalker,
      isRootActive: () => true,
      iterator: roundIterator,
      maximumWork,
      referencesRemaining,
      visitRoot: () => undefined,
      walkers
    })
  );

  const firstSlice = run(iterator, references.length);
  const secondSlice = run(iterator, firstSlice.referencesRemaining);
  const thirdSlice = run(iterator, secondSlice.referencesRemaining);

  assert.equal(thirdSlice.complete, true);
  assert.deepEqual(firstSlice.incompleteReferences, [references[0]]);
  assert.deepEqual(secondSlice.incompleteReferences, []);
  assert.deepEqual(thirdSlice.incompleteReferences, []);

  const firstRetry = run(firstSlice.incompleteReferences.values(), 1);
  const secondRetry = run(firstRetry.incompleteReferences.values(), 1);
  const finalRetry = run(secondRetry.incompleteReferences.values(), 1);

  assert.equal(firstRetry.processed, 400);
  assert.equal(secondRetry.processed, 400);
  assert.equal(finalRetry.processed, 1);
  assert.equal(finalRetry.incomplete, false);
  assert.deepEqual(finalRetry.incompleteReferences, []);
  assert.equal(deepNodesRemaining, 0);
});

test("rate-limits incomplete and complete shadow discovery passes", () => {
  assert.equal(getShadowDiscoveryDelay(false, 250, 1000), 250);
  assert.equal(getShadowDiscoveryDelay(true, 250, 1000), 1000);
  assert.equal(getShadowDiscoveryDelay(false, 0, 1000), 1);
});

test("periodically interrupts shadow discovery retries with a full round", () => {
  assert.equal(shouldRunShadowDiscoveryRetryRound(1, 0, 4), true);
  assert.equal(shouldRunShadowDiscoveryRetryRound(1, 3, 4), true);
  assert.equal(shouldRunShadowDiscoveryRetryRound(1, 4, 4), false);
  assert.equal(shouldRunShadowDiscoveryRetryRound(0, 0, 4), false);
});

test("runs shadow discovery only while translation is active in a visible document", () => {
  assert.equal(shouldRunShadowDiscovery(true, "visible"), true);
  assert.equal(shouldRunShadowDiscovery(true, "hidden"), false);
  assert.equal(shouldRunShadowDiscovery(false, "visible"), false);
});
