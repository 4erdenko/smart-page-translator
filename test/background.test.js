const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");
const providerCore = require("../src/lib/provider-core.js");
const translationCore = require("../src/lib/translation-core.js");

const backgroundSource = readFileSync(require.resolve("../src/background.js"), "utf8");
const contentSource = readFileSync(require.resolve("../src/content.js"), "utf8");
const pdfSource = readFileSync(require.resolve("../src/pdf/pdf.js"), "utf8");
const popupSource = readFileSync(require.resolve("../src/popup/popup.js"), "utf8");
const CACHE_ENTRY_PREFIX = "translationCacheEntryV1:";

function getStoredCache(storageData) {
  return Object.fromEntries(Object.entries(storageData)
    .filter(([key]) => key.startsWith(CACHE_ENTRY_PREFIX))
    .map(([key, entry]) => [key.slice(CACHE_ENTRY_PREFIX.length), entry]));
}

function createResponse(translations) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ translations }) }
        }],
        usage: { total_tokens: 10 }
      };
    }
  };
}

function createInvalidResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: "stop",
          message: { content: "not-json" }
        }]
      };
    }
  };
}

function createEmptyResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: "stop",
          message: { content: "" }
        }]
      };
    }
  };
}

function createLengthResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: "length",
          message: { content: "" }
        }]
      };
    }
  };
}

function createTemporaryErrorResponse() {
  return {
    ok: false,
    status: 503,
    async json() {
      return {};
    }
  };
}

function createHarness({
  browserProtocol = "chrome-extension:",
  detectLanguage,
  fetchImpl,
  sha256HexImpl,
  storage = {},
  storageAccessError,
  storageAccessSupported = true,
  storageRemove,
  storageSet,
  tabGet,
  tabSendMessage
}) {
  let messageListener;
  let commandListener;
  let contextMenuListener;
  let installedListener;
  const actionCalls = [];
  const accessLevelCalls = [];
  const storageGetKeys = [];
  const tabMessages = [];
  const createdTabs = [];
  const storageData = {
    providerApiKeysV1: { deepseek: "test-api-key-for-background" },
    ...storage
  };
  const browser = {
    action: {
      setBadgeBackgroundColor(options) {
        actionCalls.push({ method: "setBadgeBackgroundColor", options });
      },
      setBadgeText(options) {
        actionCalls.push({ method: "setBadgeText", options });
      }
    },
    contextMenus: {
      create() {},
      async remove() {},
      onClicked: {
        addListener(listener) {
          contextMenuListener = listener;
        }
      }
    },
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        }
      }
    },
    i18n: {
      detectLanguage: detectLanguage || (async () => ({
        isReliable: true,
        languages: [{ language: "pt", percentage: 100 }]
      })),
      getMessage() {
        return "";
      }
    },
    runtime: {
      getURL(path = "") {
        return `${browserProtocol}//test/${path}`;
      },
      onInstalled: {
        addListener(listener) {
          installedListener = listener;
        }
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      local: {
        async get(key) {
          storageGetKeys.push(key);

          if (typeof key === "string") {
            return { [key]: storageData[key] };
          }

          if (Array.isArray(key)) {
            return Object.fromEntries(key
              .filter((storageKey) => Object.hasOwn(storageData, storageKey))
              .map((storageKey) => [storageKey, storageData[storageKey]]));
          }

          return { ...storageData };
        },
        async remove(key) {
          if (storageRemove) {
            await storageRemove(key, storageData);
          } else {
            for (const storageKey of Array.isArray(key) ? key : [key]) {
              delete storageData[storageKey];
            }
          }
        },
        async set(value) {
          if (storageSet) {
            await storageSet(value, storageData);
          } else {
            Object.assign(storageData, value);
          }
        },
        async setAccessLevel(value) {
          accessLevelCalls.push(value);

          if (storageAccessError) {
            throw storageAccessError;
          }
        }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      async create(options) {
        createdTabs.push(options);
        return { id: 8, ...options };
      },
      async get(tabId) {
        return tabGet
          ? tabGet(tabId)
          : { id: tabId, incognito: false, url: "https://example.com/page" };
      },
      async query() {
        return [{ id: 7 }];
      },
      async sendMessage(tabId, message, options) {
        await tabSendMessage?.(tabId, message, options);
        tabMessages.push({ message, options, tabId });
      }
    }
  };

  if (!storageAccessSupported) {
    delete browser.storage.local.setAccessLevel;
  }

  const context = {
    AbortController,
    TextEncoder,
    URL,
    WeakRef,
    browser,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: fetchImpl,
    setTimeout(callback, milliseconds, ...args) {
      const timer = setTimeout(callback, milliseconds, ...args);
      timer.unref?.();
      return timer;
    }
  };
  context.globalThis = context;
  context.SmartTranslationProviderCore = providerCore;
  context.SmartTranslationCore = sha256HexImpl
    ? { ...translationCore, sha256Hex: sha256HexImpl }
    : translationCore;
  vm.runInNewContext(backgroundSource, context, { filename: "background.js" });

  return {
    accessLevelCalls,
    actionCalls,
    createdTabs,
    install(details) {
      return installedListener(details);
    },
    sendCommand(command) {
      return commandListener(command);
    },
    send(message, sender = {
      tab: { id: 7, url: "https://example.com/page" },
      url: browser.runtime.getURL("")
    }) {
      return messageListener(message, sender);
    },
    sendContextMenu(info, tab = { id: 7 }) {
      return contextMenuListener(info, tab);
    },
    storageData,
    storageGetKeys,
    tabMessages
  };
}

function contentSender(url = "https://example.com/page", incognito = false) {
  return {
    frameId: 0,
    tab: { id: 7, incognito, url },
    url
  };
}

function translationItem(text = "Adicionar ao carrinho") {
  return [{
    id: "0",
    text,
    context: "interface:button",
    kind: "interface",
    protectedTerms: []
  }];
}

test("content settings do not load the translation cache", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: { siteRules: { "https://example.com": "always" } },
      translationCacheV1: { one: { translation: "Один" } }
    }
  });

  const contentSettings = await harness.send(
    { type: "getSettings", site: "https://private.example" },
    contentSender()
  );
  assert.equal(Object.hasOwn(contentSettings, "cacheEntries"), false);
  assert.equal(Object.hasOwn(contentSettings, "hasApiKey"), false);
  assert.equal(Object.hasOwn(contentSettings, "providers"), false);
  assert.equal(Object.hasOwn(contentSettings.settings, "providerModels"), false);
  assert.equal(Object.hasOwn(contentSettings.settings, "siteRules"), false);
  assert.equal(contentSettings.site, "https://example.com");
  assert.equal(contentSettings.siteMode, "always");
  assert.equal(harness.storageGetKeys.length, 1);

  const uiSettings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });
  assert.equal(uiSettings.cacheEntries, 1);
  assert.ok(uiSettings.cacheBytes > 0);
  assert.equal(uiSettings.cacheMaxBytes, translationCore.MAX_CACHE_BYTES);
  assert.equal(harness.storageGetKeys.includes(null), true);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 1);
});

test("migrates the legacy default cache size to 16,000 phrases", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        cacheMaxEntries: 8000
      }
    }
  });
  const response = await harness.send({ type: "getSettings" });

  assert.equal(response.settings.cacheMaxEntries, 16000);
  assert.equal(harness.storageData.settingsV1.cacheMaxEntries, 16000);
  assert.equal(harness.storageData.settingsV1.version, 2);
});

test("opens onboarding once for a new installation", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  await harness.install({ reason: "install", temporary: false });

  assert.equal(harness.storageData.settingsV1.cacheMaxEntries, 16000);
  assert.equal(harness.storageData.onboardingShownVersion, 2);
  assert.equal(harness.createdTabs.length, 1);
  assert.equal(
    harness.createdTabs[0].url,
    "chrome-extension://test/onboarding/onboarding.html"
  );
});

test("normalizes protected terms and exposes them without other private settings", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        protectedTerms: [
          "  AirPods   Pro  ",
          "airpods pro",
          "A",
          "x".repeat(101),
          "Jane Doe"
        ]
      }
    }
  });
  const contentSettings = await harness.send(
    { type: "getSettings" },
    contentSender()
  );

  assert.deepEqual(
    Array.from(contentSettings.settings.protectedTerms),
    ["AirPods Pro", "Jane Doe"]
  );
  assert.equal(Object.hasOwn(contentSettings.settings, "siteRules"), false);
});

test("routes the selection context menu to the originating frame", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  harness.sendContextMenu({
    frameId: 3,
    menuItemId: "translate-selection",
    selectionText: "Selected text"
  }, { id: 21 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(harness.tabMessages.at(-1))), {
    message: {
      type: "translateSelection",
      text: "Selected text"
    },
    options: { frameId: 3 },
    tabId: 21
  });
});

test("does not translate context-menu selections from editable fields", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  harness.sendContextMenu({
    editable: true,
    frameId: 0,
    menuItemId: "translate-selection",
    selectionText: "Private draft"
  }, { id: 21 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.tabMessages, []);
});

test("routes explicit editable translation without reusing the selection command", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  harness.sendContextMenu({
    editable: true,
    frameId: 2,
    menuItemId: "translate-editable",
    selectionText: "Private draft"
  }, { id: 21 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(harness.tabMessages.at(-1))), {
    message: {
      type: "translateEditable",
      text: "Private draft"
    },
    options: { frameId: 2 },
    tabId: 21
  });
});

test("routes browser commands to the active top frame", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  await harness.sendCommand("cycle-view-mode");

  assert.deepEqual(JSON.parse(JSON.stringify(harness.tabMessages.at(-1))), {
    message: { type: "cycleViewMode" },
    options: { frameId: 0 },
    tabId: 7
  });
});

test("broadcasts editable translation commands to the focused frame", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  await harness.sendCommand("translate-editable");

  assert.deepEqual(JSON.parse(JSON.stringify(harness.tabMessages.at(-1))), {
    message: { type: "translateEditable" },
    tabId: 7
  });
});

test("top frames silently ignore editable commands focused inside child frames", () => {
  const handlerStart = contentSource.indexOf('if (message?.type === "translateEditable")');
  const handlerEnd = contentSource.indexOf('if (message?.type === "settingsChanged")', handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(
    contentSource,
    /function hasFocusedChildFrame\(\) \{\s+return \["FRAME", "IFRAME"\]\.includes/u
  );
  assert.match(
    contentSource,
    /async function translateEditable\(\{ silentIfUnavailable = false \} = \{\}\)/u
  );
  assert.match(
    handler,
    /translateEditable\(\{ silentIfUnavailable: hasFocusedChildFrame\(\) \}\)/u
  );
});

test("cross-origin frames require their own explicit always rule", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        siteRules: {
          "https://example.com": "always",
          "https://trusted-frame.example": "always"
        }
      }
    }
  });
  const sameOriginFrame = await harness.send(
    { type: "getSettings" },
    {
      frameId: 1,
      tab: { id: 7, url: "https://example.com/page" },
      url: "https://example.com/frame"
    }
  );
  const thirdPartyFrame = await harness.send(
    { type: "getSettings" },
    {
      frameId: 2,
      tab: { id: 7, url: "https://example.com/page" },
      url: "https://third-party.example/frame"
    }
  );
  const trustedFrame = await harness.send(
    { type: "getSettings" },
    {
      frameId: 3,
      tab: { id: 7, url: "https://example.com/page" },
      url: "https://trusted-frame.example/frame"
    }
  );
  const inheritedBlankFrame = await harness.send(
    { type: "getSettings" },
    {
      frameId: 4,
      origin: "https://example.com",
      tab: { id: 7, url: "https://example.com/page" },
      url: "about:blank"
    }
  );
  const opaqueBlankFrame = await harness.send(
    { type: "getSettings" },
    {
      frameId: 5,
      origin: "null",
      tab: { id: 7, url: "https://example.com/page" },
      url: "about:blank"
    }
  );

  assert.equal(sameOriginFrame.siteMode, "always");
  assert.equal(thirdPartyFrame.site, "https://third-party.example");
  assert.equal(thirdPartyFrame.siteMode, "never");
  assert.equal(trustedFrame.siteMode, "always");
  assert.equal(inheritedBlankFrame.site, "https://example.com");
  assert.equal(inheritedBlankFrame.siteMode, "always");
  assert.equal(opaqueBlankFrame.site, "");
  assert.equal(opaqueBlankFrame.siteMode, "never");
});

test("uses the browser-specific trusted storage access signature", async () => {
  const chrome = createHarness({ fetchImpl: async () => createResponse([]) });
  const firefox = createHarness({
    browserProtocol: "moz-extension:",
    fetchImpl: async () => createResponse([])
  });

  await Promise.all([
    chrome.send({ type: "getSettings", site: "https://example.com" }),
    firefox.send({ type: "getSettings", site: "https://example.com" })
  ]);

  assert.equal(JSON.stringify(chrome.accessLevelCalls), '[{"accessLevel":"TRUSTED_CONTEXTS"}]');
  assert.deepEqual(firefox.accessLevelCalls, ["TRUSTED_CONTEXTS"]);
});

test("continues in Firefox when storage access levels are unavailable", async () => {
  const harness = createHarness({
    browserProtocol: "moz-extension:",
    fetchImpl: async () => createResponse([]),
    storageAccessSupported: false
  });

  const settings = await harness.send({ type: "getSettings", site: "https://example.com" });

  assert.equal(settings.settings.targetLanguage, "ru");
  assert.deepEqual(harness.accessLevelCalls, []);
  assert.equal(harness.storageGetKeys.length, 2);
});

test("fails closed outside Firefox when storage access levels are unavailable", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storageAccessSupported: false
  });

  await assert.rejects(
    harness.send({ type: "getSettings", site: "https://example.com" }),
    /cannot isolate extension storage/u
  );
  assert.equal(harness.storageGetKeys.length, 0);
});

test("fails closed when local storage cannot be isolated", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storageAccessError: new Error("Storage isolation failed.")
  });

  await assert.rejects(
    harness.send({ type: "getSettings", site: "https://example.com" }),
    /Storage isolation failed/u
  );
  assert.equal(harness.storageGetKeys.length, 0);
});

test("broadcasts a settings invalidation without exposing settings", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  await harness.send({
    type: "updateSettings",
    site: "https://example.com",
    settings: { targetLanguage: "en" }
  });

  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.tabMessages[0].tabId, 7);
  assert.equal(JSON.stringify(harness.tabMessages[0].message), '{"type":"settingsChanged"}');
});

test("rejects privileged messages from content scripts", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });
  const messages = [
    { type: "clearCache" },
    { type: "getCacheStats" },
    { type: "listProviderModels", provider: "deepseek" },
    { type: "setSiteMode", site: "https://example.com", mode: "always" },
    { type: "testProviderConnection", provider: "deepseek" },
    { type: "updateProviderKey", provider: "deepseek", action: "clear" },
    { type: "updateSettings", settings: { targetLanguage: "en" } }
  ];

  for (const message of messages) {
    await assert.rejects(
      harness.send(message, contentSender()),
      /trusted extension pages/u
    );
  }
});

test("does not persist website rules selected from a private tab", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    tabGet: async (tabId) => ({
      id: tabId,
      incognito: true,
      url: "https://example.com/page"
    })
  });

  await assert.rejects(
    harness.send({
      type: "setSiteMode",
      site: "https://example.com",
      tabId: 7,
      mode: "always"
    }),
    /private tabs/u
  );
  assert.equal(harness.storageData.settingsV1?.siteRules?.["https://example.com"], undefined);
});

test("does not read or write the persistent translation cache in private tabs", async () => {
  const text = "Private page phrase";
  const identity = translationCore.createCacheIdentity({
    context: "interface:button",
    kind: "interface",
    model: "deepseek-v4-flash",
    protectedTerms: [],
    provider: "deepseek",
    sourceLanguage: "auto",
    targetLanguage: "ru",
    text
  });
  const cacheKey = await translationCore.sha256Hex(identity);
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([{ id: "0", text: "Свежий перевод" }]);
    },
    storage: {
      [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: {
        identity,
        lastUsed: Date.now(),
        translation: "Сохранённый перевод"
      }
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem(text)
  }, contentSender("https://example.com/private", true));

  assert.equal(result.translations[0].text, "Свежий перевод");
  assert.equal(result.cacheEntries, 0);
  assert.equal(fetchCount, 1);
  assert.equal(harness.storageData[`${CACHE_ENTRY_PREFIX}${cacheKey}`].translation, "Сохранённый перевод");
  assert.equal(
    Object.keys(getStoredCache(harness.storageData)).filter((key) => key !== cacheKey).length,
    0
  );
  assert.equal(harness.storageGetKeys.includes(null), false);
});

test("explicit private translations bypass the persistent cache", async () => {
  const harness = createHarness({
    async fetchImpl() {
      return createResponse([{ id: "0", text: "Переведённый черновик" }]);
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    persistCache: false,
    sourceLanguage: "auto",
    items: [{
      ...translationItem("Editable draft")[0],
      kind: "editable"
    }]
  }, contentSender());

  assert.equal(result.translations[0].text, "Переведённый черновик");
  assert.equal(result.cacheEntries, 0);
  assert.deepEqual(getStoredCache(harness.storageData), {});
});

test("rejects oversized translation batches before contacting a provider", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([]);
    }
  });
  const invalidBatches = [
    Array.from({ length: 49 }, (_, index) => ({ ...translationItem(`Phrase ${index}`)[0], id: String(index) })),
    translationItem("x".repeat(8001)),
    [translationItem("x".repeat(6000))[0], { ...translationItem("y".repeat(6000))[0], id: "1" }],
    [{ ...translationItem()[0], id: "x".repeat(65) }],
    [{ ...translationItem()[0], context: "x".repeat(401) }],
    [{ ...translationItem()[0], protectedTerms: Array.from({ length: 21 }, (_, index) => `Brand ${index}`) }]
  ];

  for (const items of invalidBatches) {
    await assert.rejects(
      harness.send({ type: "translateBatch", sourceLanguage: "auto", items }),
      /batch|invalid item/u
    );
  }

  assert.equal(fetchCount, 0);
});

test("enforces the provider input limit after protecting repeated brand names", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([]);
    }
  });
  const source = "AA ".repeat(2600).trim();
  const items = [{ ...translationItem(source)[0], protectedTerms: ["AA"] }];

  await assert.rejects(
    harness.send({ type: "translateBatch", sourceLanguage: "auto", items }),
    /safe provider limit/u
  );
  assert.equal(fetchCount, 0);
});

test("preserves brand spelling when the protected term uses different capitalization", async () => {
  let providerText = "";
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      providerText = payload.items[0].text;
      return createResponse([{
        id: "0",
        text: providerText.replace(" Milk", " Молоко")
      }]);
    }
  });
  const response = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: [{
      ...translationItem("NORTHSTAR Milk")[0],
      kind: "product-title",
      protectedTerms: ["Northstar"]
    }]
  });

  assert.match(providerText, /^\[\[SPT_PROTECTED_0\]\] Milk$/u);
  assert.equal(response.translations[0].text, "NORTHSTAR Молоко");
});

test("starts translation motion only for owned cache misses", async () => {
  let markFetchStarted;
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchResponse = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const harness = createHarness({
    fetchImpl() {
      markFetchStarted();
      return fetchResponse;
    }
  });
  const message = {
    type: "translateBatch",
    motionId: "0:1",
    sourceLanguage: "auto",
    items: translationItem()
  };
  const translation = harness.send(message, contentSender());

  await fetchStarted;
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(JSON.stringify(harness.tabMessages[0]), JSON.stringify({
    message: { type: "translationMotionStart", motionId: "0:1" },
    options: { frameId: 0 },
    tabId: 7
  }));

  const duplicate = harness.send({ ...message, motionId: "0:2" }, contentSender());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.tabMessages.length, 1);

  resolveFetch(createResponse([{ id: "0", text: "Добавить в корзину" }]));
  await Promise.all([translation, duplicate]);
  await harness.send({ ...message, motionId: "0:3" }, contentSender());
  assert.equal(harness.tabMessages.length, 1);
});

test("does not start translation motion without a provider key", async () => {
  const harness = createHarness({
    storage: { providerApiKeysV1: {} }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      motionId: "0:missing-key",
      sourceLanguage: "auto",
      items: translationItem()
    }, contentSender()),
    /No DeepSeek API key/u
  );
  assert.equal(harness.tabMessages.length, 0);
});

test("bounds provider HTTP retries", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createTemporaryErrorResponse();
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Retry accounting phrase")
    }),
    /temporarily/u
  );
  assert.equal(fetchCount, 3);
});

test("cancels active provider requests for the requesting frame without retrying", async () => {
  let markStarted;
  let fetchCount = 0;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const harness = createHarness({
    fetchImpl(_url, options) {
      fetchCount += 1;
      markStarted();

      return new Promise((resolve, reject) => {
        const rejectCancellation = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (options.signal.aborted) {
          rejectCancellation();
          return;
        }

        options.signal.addEventListener("abort", rejectCancellation, { once: true });
      });
    }
  });
  const sender = contentSender();
  const translation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Cancelled route phrase")
  }, sender);

  await started;
  const result = await harness.send({ type: "cancelTranslations" }, sender);

  await assert.rejects(translation, /cancelled/u);
  assert.equal(result.cancelled, 1);
  assert.equal(fetchCount, 1);
});

test("cancelling one frame does not abort an identical request from another frame", async () => {
  const fetches = [];
  const harness = createHarness({
    fetchImpl(_url, options) {
      return new Promise((resolve, reject) => {
        const request = { resolve, signal: options.signal };
        fetches.push(request);
        options.signal.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
  });
  const topFrame = contentSender();
  const childFrame = {
    frameId: 1,
    tab: { id: 7, url: "https://example.com/page" },
    url: "https://example.com/frame"
  };
  const message = {
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Shared frame phrase")
  };
  const topTranslation = harness.send(message, topFrame);

  while (fetches.length < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const childTranslation = harness.send(message, childFrame);

  while (fetches.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await harness.send({ type: "cancelTranslations" }, topFrame);
  fetches[1].resolve(createResponse([{ id: "0", text: "Перевод дочернего фрейма" }]));

  await assert.rejects(topTranslation, /cancelled/u);
  const childResult = await childTranslation;

  assert.equal(fetches[0].signal.aborted, true);
  assert.equal(fetches[1].signal.aborted, false);
  assert.equal(childResult.translations[0].text, "Перевод дочернего фрейма");
});

test("does not retry terminal provider errors based on their message text", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return {
        ok: false,
        status: 400,
        async json() {
          return { error: { message: "Network option is invalid" } };
        }
      };
    }
  });

  await assert.rejects(
    harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem() }),
    /Network option is invalid/u
  );
  assert.equal(fetchCount, 1);
});

test("acknowledges settings broadcasts before refreshing the policy", () => {
  const handlerStart = contentSource.indexOf('if (message?.type === "settingsChanged")');
  const handlerEnd = contentSource.indexOf("return undefined;", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /void refreshPolicy\(\);/u);
  assert.match(handler, /return Promise\.resolve\(publicStatus\(\)\);/u);
  assert.doesNotMatch(handler, /return applyPolicy/u);
});

test("invalidates stale page work and refreshes automatic policy after SPA navigation", () => {
  const handlerStart = contentSource.indexOf("function checkRouteChange()");
  const handlerEnd = contentSource.indexOf("function handleVisibilityChange()", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(
    handler,
    /policyRevision \+= 1;\s+revision \+= 1;\s+closeSelectionUi\(\);\s+clearPending\(\);/u
  );
  assert.match(handler, /routeRescanPending = true;/u);
  assert.match(handler, /shouldRefreshRoutePolicy\(state\.siteMode, state\.sourceLanguage\)/u);
  assert.match(handler, /applyPolicy\(currentSettings, state\.siteMode\)\.then\(finishRouteRescan\)/u);
  assert.doesNotMatch(handler, /routeSiteMode/u);
  assert.match(contentSource, /if \(checkRouteChange\(\)\) \{\s+return;\s+\}/u);
});

test("settings refreshes consume a pending SPA rescan without stale timers", () => {
  const handlerStart = contentSource.indexOf("async function refreshPolicy()");
  const handlerEnd = contentSource.indexOf("function checkRouteChange()", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /clearTimeout\(routePolicyTimer\);\s+clearTimeout\(routeScanTimer\);/u);
  assert.match(handler, /const startedTranslation = await applyPolicy[\s\S]*finishRouteRescan\(startedTranslation\);/u);
});

test("stops page observers when refreshing settings fails", () => {
  const handlerStart = contentSource.indexOf("async function refreshPolicy()");
  const handlerEnd = contentSource.indexOf("function checkRouteChange()", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /state\.error = [\s\S]*revision \+= 1;\s+clearPending\(\);\s+pauseObserver\(\);\s+updateRouteMonitoring\(\);/u);
});

test("starts one-time translation and route monitoring after a manual retry", () => {
  const handlerStart = contentSource.indexOf('if (message?.type === "translateNow")');
  const handlerEnd = contentSource.indexOf('if (message?.type === "restoreNow"', handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);
  const enableStart = contentSource.indexOf("async function enableTranslation(");
  const enableEnd = contentSource.indexOf("function destroySelectionUi()", enableStart);
  const enableHandler = contentSource.slice(enableStart, enableEnd);

  assert.match(
    enableHandler,
    /if \(viewSwitchJob\) \{\s+await viewSwitchJob\.promise;\s+\}[\s\S]*if \(restoreJob\) \{\s+await restoreJob\.promise;\s+\}/u
  );
  assert.match(
    enableHandler,
    /state\.error = "";\s+state\.enabled = true;\s+state\.siteMode = "session";\s+state\.viewMode = viewMode;\s+lastActiveViewMode = viewMode;\s+routeRescanPending = false;\s+updateRouteMonitoring\(\);\s+resumeObserver\(\);/u
  );
  assert.match(handler, /if \(message\?\.type === "translateNow"\) \{\s+return enableTranslation\(\);/u);
});

test("discovers brand terms before translation batches can leave the page", () => {
  const scanStart = contentSource.indexOf("function scanDocument()");
  const scanEnd = contentSource.indexOf("function scanSubtree(", scanStart);
  const documentScan = contentSource.slice(scanStart, scanEnd);
  const batchStart = contentSource.indexOf("function takeBatch(");
  const batchEnd = contentSource.indexOf("function trackTextNode(", batchStart);
  const takeBatch = contentSource.slice(batchStart, batchEnd);

  assert.match(documentScan, /let scanPhase = "brands";/u);
  assert.match(documentScan, /scanPhase === "brands"[\s\S]*collectBrandNode\(node\)/u);
  assert.match(contentSource, /const brandElement = findClosestTextKindElement\(element, "brand-name"\);/u);
  assert.match(takeBatch, /segment\.protectedTerms = selectProtectedTerms\(/u);
  assert.ok((contentSource.match(/selectProtectedTerms\(/gu) || []).length >= 2);
  assert.match(contentSource, /const textKind = getInheritedTextKind\(node\.parentElement\);/u);
  assert.match(contentSource, /activeBrandScanCount > 0/u);
});

test("cancels stale translation requests when pending page work is cleared", () => {
  const handlerStart = contentSource.indexOf("function clearPending()");
  const handlerEnd = contentSource.indexOf("function removeMotion()", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /cancelActiveTranslations\(\);/u);
  assert.match(contentSource, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*cancelActiveTranslations\(\);/u);
});

test("switches all page views without destroying translation records", () => {
  const originalStart = contentSource.indexOf("async function showOriginal()");
  const originalEnd = contentSource.indexOf("async function showTranslation()", originalStart);
  const originalHandler = contentSource.slice(originalStart, originalEnd);
  const activeStart = contentSource.indexOf("async function showActiveView(");
  const activeEnd = originalStart;
  const activeHandler = contentSource.slice(activeStart, activeEnd);

  assert.match(originalHandler, /return showActiveView\("original"\);/u);
  assert.doesNotMatch(originalHandler, /restorePage\(/u);
  assert.match(contentSource, /\["bilingual", "translated"\]\.includes\(state\.viewMode\)/u);
  assert.match(activeHandler, /if \(viewSwitchJob\) \{\s+await viewSwitchJob\.promise;\s+\}/u);
  assert.match(activeHandler, /if \(restoreJob\) \{\s+await restoreJob\.promise;\s+\}/u);
  assert.match(activeHandler, /type: "text"[\s\S]*type: "attribute"/u);
  assert.match(activeHandler, /state\.viewMode = viewMode;[\s\S]*runViewSwitchSlice\(\)/u);
  assert.match(contentSource, /async function applySettings[\s\S]*await viewSwitchJob\.promise;/u);
  assert.match(contentSource, /async function showTranslation\(\) \{\s+return showActiveView\("translated"\);/u);
  assert.match(contentSource, /async function showBilingual\(\) \{\s+return showActiveView\("bilingual"\);/u);
});

test("keeps PDF user cancellation separate from provider failures", () => {
  assert.match(pdfSource, /cancelledByUser: false/u);
  assert.match(pdfSource, /if \(!run\.cancelledByUser\) \{\s+run\.error \|\|= error;/u);
  assert.match(
    pdfSource,
    /if \(run\.cancelledByUser\) \{\s+showProgress\(t\("translationCancelled"/u
  );
  assert.match(
    pdfSource,
    /activeRun\.cancelled = true;\s+activeRun\.cancelledByUser = true;/u
  );
});

test("releases detached PDF page views without resizing an active render", () => {
  assert.match(
    pdfSource,
    /function releasePageView\(view\) \{\s+view\.wanted = false;\s+if \(view\.queued\) \{\s+return;\s+\}\s+clearCanvas\(view\.originalCanvas\);\s+clearCanvas\(view\.translatedCanvas\);/u
  );
  assert.match(
    pdfSource,
    /if \(entry\.isIntersecting\) \{[\s\S]*queuePagePreview\(page, view\);[\s\S]*\} else \{\s+releasePageView\(view\);/u
  );
  assert.doesNotMatch(pdfSource, /PAGE_RELEASE_DELAY|releaseTimer/u);
  assert.match(
    pdfSource,
    /function clearPageViews\(\) \{[\s\S]*pageViewObserver\?\.disconnect\(\);[\s\S]*pageViews\.clear\(\);[\s\S]*elements\.pages\.replaceChildren\(\);/u
  );
  assert.match(
    pdfSource,
    /elements\.removeButton\.addEventListener\("click", \(\) => \{\s+clearDocument\(\);/u
  );
  assert.match(
    pdfSource,
    /window\.addEventListener\("focus", \(\) => \{\s+if \(!busy\) \{/u
  );
  assert.match(
    pdfSource,
    /if \(!queued\.view\.wanted \|\| queued\.view\.rendered \|\| documentState !== queued\.state\) \{\s+queued\.view\.queued = false;\s+continue;/u
  );
  assert.match(
    pdfSource,
    /function disposePendingLoad\([\s\S]*load\.loadingTask\.destroy\(\)/u
  );
  assert.match(
    pdfSource,
    /function handleFile\(file\) \{\s+if \(busy\) \{\s+return;/u
  );
});

test("renders PDF translations as bounded page overlays and exports them", () => {
  assert.match(pdfSource, /createPdfTextBlocks\(fragments, viewport\.width\)/u);
  assert.match(pdfSource, /"PDF visual text block\."/u);
  assert.doesNotMatch(pdfSource, /PDF page \$\{page\.number\}/u);
  assert.match(pdfSource, /new IntersectionObserver\(/u);
  assert.match(pdfSource, /activePreviewRenders < 2/u);
  assert.match(pdfSource, /PDFDocument\.create\(\)/u);
  assert.doesNotMatch(pdfSource, /PDFDocument\.load\(/u);
  assert.match(pdfSource, /drawTranslationOverlay\([\s\S]*drawText: false/u);
  assert.match(pdfSource, /outputDocument\.embedPng\(pageImageBytes\)/u);
  assert.match(pdfSource, /outputPage\.drawImage\(pageImage/u);
  assert.match(pdfSource, /outputDocument\.registerFontkit\(fontkit\)/u);
  assert.match(pdfSource, /outputDocument\.embedFont\(regularBytes, \{ subset: true \}\)/u);
  assert.match(pdfSource, /outputPage\.drawText\(line/u);
  assert.match(pdfSource, /elements\.translationBadge\.hidden = !translated;/u);
  assert.match(pdfSource, /link\.download = translatedFileName\(\);/u);
});

test("fails PDF export instead of drawing text outside its region", () => {
  assert.match(pdfSource, /const MIN_EXPORT_FONT_SIZE = 0\.75;/u);
  assert.match(
    pdfSource,
    /if \(fontSize <= MIN_EXPORT_FONT_SIZE\) \{[\s\S]*"pdfTranslationDoesNotFit"/u
  );
});

test("bounds flattened PDF page data before embedding it", () => {
  assert.match(pdfSource, /const MAX_EXPORT_IMAGE_BYTES = 128 \* 1024 \* 1024;/u);
  assert.match(
    pdfSource,
    /embeddedImageBytes \+= pageImageBytes\.byteLength;\s+if \(embeddedImageBytes > MAX_EXPORT_IMAGE_BYTES\) \{/u
  );
});

test("defers PDF settings refreshes while document work is active", () => {
  assert.match(
    pdfSource,
    /if \(busy\) \{\s+settingsRefreshPending = true;\s+return;\s+\}/u
  );
  assert.match(
    pdfSource,
    /if \(wasBusy && !busy && settingsRefreshPending\) \{[\s\S]*loadSettings\(\)/u
  );
});

test("shows PDF errors and progress before a completed bilingual status", () => {
  const renderStart = popupSource.indexOf("function renderPageStatus(status)");
  const renderEnd = popupSource.indexOf("async function readPageStatus()", renderStart);
  const handler = popupSource.slice(renderStart, renderEnd);
  const errorIndex = handler.indexOf("if (status.error)");
  const translatingIndex = handler.indexOf("else if (status.translating)");
  const bilingualIndex = handler.indexOf('status.viewMode === "bilingual"');

  assert.ok(errorIndex >= 0);
  assert.ok(translatingIndex > errorIndex);
  assert.ok(bilingualIndex > translatingIndex);
});

test("refuses to mutate a detached contenteditable range", () => {
  const targetStart = contentSource.indexOf("function getEditableTranslationTarget()");
  const targetEnd = contentSource.indexOf("async function translateEditable(", targetStart);
  const target = contentSource.slice(targetStart, targetEnd);

  assert.match(
    contentSource,
    /return Boolean\(container\?\.isConnected && element\?\.contains\(container\)\);/u
  );
  assert.match(
    target,
    /!isRangeInsideElement\(range, activeElement\)[\s\S]*!textNode\.isConnected[\s\S]*!activeElement\.contains\(textNode\)/u
  );
});

test("preserves editable markup and boundary whitespace during translation", () => {
  const targetStart = contentSource.indexOf("function getEditableTranslationTarget()");
  const targetEnd = contentSource.indexOf("async function translateEditable(", targetStart);
  const target = contentSource.slice(targetStart, targetEnd);

  assert.match(target, /const boundary = splitBoundaryWhitespace\(selectedText\);/u);
  assert.match(
    target,
    /range\.startContainer !== range\.endContainer[\s\S]*range\.startContainer\.nodeType !== Node\.TEXT_NODE/u
  );
  assert.match(
    target,
    /const replacement = `\$\{boundary\.leading\}\$\{translation\}\$\{boundary\.trailing\}`;/u
  );
  assert.match(target, /textNode\.nodeValue = `\$\{originalValue\.slice/u);
  assert.doesNotMatch(target, /range\.deleteContents\(\)|range\.insertNode\(/u);
});

test("uses one idle lane for offscreen translation work", () => {
  const drainStart = contentSource.indexOf("function drainPending()");
  const drainEnd = contentSource.indexOf("function cancelScheduledFlush()", drainStart);
  const drain = contentSource.slice(drainStart, drainEnd);
  const scheduleStart = contentSource.indexOf("function scheduleFlush()");
  const scheduleEnd = contentSource.indexOf("function cancelActiveTranslations()", scheduleStart);
  const schedule = contentSource.slice(scheduleStart, scheduleEnd);

  assert.match(drain, /let batch = takeBatch\(true\);/u);
  assert.match(drain, /activeOffscreenBatchCount >= 1/u);
  assert.match(schedule, /requestIdleCallback\(drainPending, \{ timeout: delay \}\)/u);
});

test("popup listens for status events without polling the page", () => {
  assert.match(popupSource, /api\.runtime\.onMessage\.addListener\(handleStatusMessage\);/u);
  assert.doesNotMatch(popupSource, /setInterval\(/u);
});

test("selection translation is bounded and does not mutate selected page text", () => {
  const selectionStart = contentSource.indexOf("async function translateSelection(");
  const selectionEnd = contentSource.indexOf("function getDeepActiveElement()", selectionStart);
  const handler = contentSource.slice(selectionStart, selectionEnd);
  const routeStart = contentSource.indexOf("function checkRouteChange()");
  const routeEnd = contentSource.indexOf("function handleVisibilityChange()", routeStart);
  const viewportStart = contentSource.indexOf("function handleViewportMovement()");
  const viewportEnd = contentSource.indexOf("async function showOriginal()", viewportStart);

  assert.match(contentSource, /const MAX_SELECTION_CHARACTERS = 4000;/u);
  assert.match(handler, /\.slice\(0, MAX_PROTECTED_TERMS_PER_ITEM\)/u);
  assert.match(handler, /type: "translateBatch"/u);
  assert.match(handler, /kind: "text"/u);
  assert.doesNotMatch(handler, /nodeValue\s*=|textContent\s*=\s*translated/u);
  assert.match(contentSource, /selectionHost\.attachShadow\(\{ mode: "closed" \}\)/u);
  assert.match(contentSource.slice(routeStart, routeEnd), /closeSelectionUi\(\);/u);
  assert.match(contentSource.slice(viewportStart, viewportEnd), /closeSelectionUi\(\);/u);
});

test("returns authoritative cache statistics without storage byte accounting", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: { translationCacheV1: { one: { translation: "Один" } } }
  });

  const stats = await harness.send({ type: "getCacheStats" });

  assert.equal(stats.cacheEntries, 1);
});

test("opening settings prunes an oversized existing cache", async () => {
  const cache = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
    `key-${index}`,
    { identity: `identity-${index}`, translation: `translation-${index}`, lastUsed: index }
  ]));
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: { cacheMaxEntries: 100 },
      translationCacheV1: cache
    }
  });

  const settings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });

  const storedCache = getStoredCache(harness.storageData);
  assert.equal(settings.cacheEntries, 100);
  assert.equal(Object.hasOwn(storedCache, "key-0"), false);
  assert.equal(Object.hasOwn(storedCache, "key-100"), true);
});

test("saving a lower cache limit returns current statistics and prunes immediately", async () => {
  const cache = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
    `key-${index}`,
    { identity: `identity-${index}`, translation: `translation-${index}`, lastUsed: index }
  ]));
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: { cacheMaxEntries: 200 },
      translationCacheV1: cache
    }
  });

  const settings = await harness.send({
    type: "updateSettings",
    site: "",
    includeCacheEntries: true,
    settings: { cacheMaxEntries: 100 }
  });

  assert.equal(settings.settings.cacheMaxEntries, 100);
  assert.equal(settings.cacheEntries, 100);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 100);
});

test("bounds queued API requests instead of retaining an unlimited number of callers", async () => {
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  let releaseRequests;
  const requestGate = new Promise((resolve) => {
    releaseRequests = resolve;
  });
  const harness = createHarness({
    async fetchImpl(_url, options) {
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await requestGate;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      activeFetches -= 1;
      return createResponse([{ id: payload.items[0].id, text: `Перевод ${payload.items[0].text}` }]);
    }
  });
  const requests = Array.from({ length: 68 }, (_, index) => harness.send({
    type: "translateBatch",
    motionId: `0:queue-${index}`,
    sourceLanguage: "auto",
    items: translationItem(`Unique phrase ${index}`)
  }, contentSender()));

  const overflowError = await Promise.race(requests.map((request) => request.then(
    () => null,
    (error) => error
  )));
  assert.match(String(overflowError?.message || overflowError), /queue is full/u);
  assert.equal(harness.tabMessages.length, 3);
  releaseRequests();
  const results = await Promise.allSettled(requests);

  assert.equal(results.filter(({ reason }) => /queue is full/u.test(String(reason?.message || reason))).length, 1);
  assert.ok(results.some(({ status }) => status === "fulfilled"));
  assert.ok(maximumActiveFetches <= 3);
  assert.equal(harness.tabMessages.length, 67);
});

test("concurrent identical cache misses share one API request while motion delivery is pending", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return createResponse([{ id: "0", text: "Добавить в корзину" }]);
    },
    async tabSendMessage() {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  const message = { type: "translateBatch", motionId: "0:1", sourceLanguage: "auto", items: translationItem() };
  const [first, second] = await Promise.all([
    harness.send(message, contentSender()),
    harness.send({ ...message, motionId: "0:2" }, contentSender())
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(first.translations[0].text, "Добавить в корзину");
  assert.equal(second.translations[0].text, "Добавить в корзину");
  assert.equal(first.apiItems + second.apiItems, 1);
  assert.equal(first.cacheEntries, 1);
  assert.equal(second.cacheEntries, 1);
  assert.equal(first.cacheHits + second.cacheHits, 1);
});

test("persists only changed cache entries after each translation batch", async () => {
  const cacheWrites = [];
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      return createResponse([{ id: "0", text: `Перевод ${payload.items[0].text}` }]);
    },
    async storageSet(value, storageData) {
      const keys = Object.keys(value);

      if (keys.some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        cacheWrites.push(keys);
      }

      Object.assign(storageData, value);
    }
  });

  await harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem("First phrase") });
  await harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem("Second phrase") });

  assert.deepEqual(cacheWrites.map(({ length }) => length), [1, 1]);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 2);
});

test("retries an incremental cache write after a transient storage failure", async () => {
  let cacheWriteCount = 0;
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([{ id: "0", text: "Сохранённый перевод" }]);
    },
    async storageSet(value, storageData) {
      if (Object.keys(value).some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        cacheWriteCount += 1;

        if (cacheWriteCount === 1) {
          throw new Error("Storage temporarily unavailable.");
        }
      }

      Object.assign(storageData, value);
    }
  });
  const message = { type: "translateBatch", sourceLanguage: "auto", items: translationItem("Stored phrase") };

  await assert.rejects(harness.send(message), /Storage temporarily unavailable/u);
  const result = await harness.send(message);

  assert.equal(result.translations[0].text, "Сохранённый перевод");
  assert.equal(fetchCount, 1);
  assert.equal(cacheWriteCount, 2);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 1);
});

test("persists keys restored after a queued cache write fails", async () => {
  let rejectFirstCacheWrite;
  let signalFirstCacheWrite;
  let signalSecondFetch;
  let cacheWriteCount = 0;
  const firstCacheWriteStarted = new Promise((resolve) => {
    signalFirstCacheWrite = resolve;
  });
  const firstCacheWriteGate = new Promise((_, reject) => {
    rejectFirstCacheWrite = reject;
  });
  const secondFetchStarted = new Promise((resolve) => {
    signalSecondFetch = resolve;
  });
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      const [{ id, text }] = payload.items;

      if (text === "Second concurrent phrase") {
        signalSecondFetch();
      }

      return createResponse([{ id, text: `Translated ${text}` }]);
    },
    async storageSet(value, storageData) {
      if (Object.keys(value).some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        cacheWriteCount += 1;

        if (cacheWriteCount === 1) {
          signalFirstCacheWrite();
          await firstCacheWriteGate;
        }
      }

      Object.assign(storageData, value);
    }
  });
  const firstRequest = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("First concurrent phrase")
  });

  await firstCacheWriteStarted;

  const secondRequest = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Second concurrent phrase")
  });

  await secondFetchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  rejectFirstCacheWrite(new Error("Transient storage failure."));

  const results = await Promise.allSettled([firstRequest, secondRequest]);

  assert.deepEqual(results.map(({ status }) => status), ["rejected", "fulfilled"]);
  assert.equal(cacheWriteCount, 2);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 2);
});

test("a failed focused retry uses a cooldown and remains refreshable", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;

      if (fetchCount === 1 || fetchCount === 3) {
        return createResponse([{ id: "0", text: "Texto por traduzir" }]);
      }

      return createInvalidResponse();
    }
  });
  const message = {
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Texto por traduzir")
  };

  const first = await harness.send(message);
  const second = await harness.send(message);
  const [cached] = Object.values(getStoredCache(harness.storageData));

  assert.ok(cached.unchangedTranslationRetryAfter > Date.now());
  cached.unchangedTranslationRetryAfter = 0;
  const third = await harness.send(message);

  assert.equal(first.translations[0].text, "Texto por traduzir");
  assert.equal(second.translations[0].text, "Texto por traduzir");
  assert.equal(third.translations[0].text, "Texto por traduzir");
  assert.equal(fetchCount, 4);
});

test("a successful unchanged focused retry remains refreshable", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([{ id: "0", text: "Texto por traduzir" }]);
    }
  });
  const message = {
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Texto por traduzir")
  };

  await harness.send(message);
  const cachedResult = await harness.send(message);

  const [cached] = Object.values(getStoredCache(harness.storageData));
  assert.equal(fetchCount, 2);
  assert.equal(cachedResult.cacheHits, 1);
  assert.equal(Object.hasOwn(cached, "unchangedTranslationVersion"), false);
  assert.ok(cached.unchangedTranslationRetryAfter > Date.now());

  cached.unchangedTranslationRetryAfter = 0;
  await harness.send(message);
  assert.equal(fetchCount, 4);
});

test("retries one empty provider response without splitting the batch", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return fetchCount === 1
        ? createEmptyResponse()
        : createResponse([{ id: "0", text: "Переведённый текст" }]);
    }
  });

  const response = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Texto por traduzir")
  });

  assert.equal(response.translations[0].text, "Переведённый текст");
  assert.equal(fetchCount, 2);
});

test("bounds empty provider response retries", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createEmptyResponse();
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Texto por traduzir")
    }),
    /empty translation response/u
  );
  assert.equal(fetchCount, 2);
});

test("rejects disproportionate item translations before caching them", async () => {
  const harness = createHarness({
    async fetchImpl() {
      return createResponse([{ id: "0", text: "x".repeat(513) }]);
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Buy")
    }),
    /invalid translation response/u
  );
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 0);
});

test("rejects oversized aggregate translation responses before caching them", async () => {
  const items = [
    translationItem("A".repeat(6000))[0],
    ...Array.from({ length: 47 }, (_, index) => ({
      ...translationItem(`${String(index).padStart(2, "0")}${"B".repeat(48)}`)[0],
      id: String(index + 1)
    }))
  ];
  const translations = items.map(({ id }, index) => ({
    id,
    text: "x".repeat(index === 0 ? 16000 : 512)
  }));
  const harness = createHarness({
    async fetchImpl() {
      return createResponse(translations);
    }
  });

  await assert.rejects(
    harness.send({ type: "translateBatch", sourceLanguage: "auto", items }),
    /invalid translation response/u
  );
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 0);
});

test("does not recursively split malformed provider responses", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createInvalidResponse();
    }
  });
  const items = Array.from({ length: 48 }, (_, index) => ({
    ...translationItem(`Phrase ${index}`)[0],
    id: String(index)
  }));

  await assert.rejects(
    harness.send({ type: "translateBatch", sourceLanguage: "auto", items }),
    /JSON|Unexpected token/iu
  );
  assert.equal(fetchCount, 1);
});

test("bounds recursive output-limit recovery attempts", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createLengthResponse();
    }
  });
  const items = Array.from({ length: 48 }, (_, index) => ({
    ...translationItem(`Phrase ${index}`)[0],
    id: String(index)
  }));

  await assert.rejects(
    harness.send({ type: "translateBatch", sourceLanguage: "auto", items }),
    /could not complete|output limit/iu
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 12);
});

test("clearing the cache is not undone by an older in-flight request", async () => {
  let resolveFetch;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const pendingResponse = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const harness = createHarness({
    fetchImpl() {
      markStarted();
      return pendingResponse;
    }
  });
  const translation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem()
  });

  await started;
  await harness.send({ type: "clearCache" });
  resolveFetch(createResponse([{ id: "0", text: "Добавить в корзину" }]));
  await translation;

  const settings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });
  assert.equal(settings.cacheEntries, 0);
});

test("clearing the cache rejects stale cache-hit metadata writes", async () => {
  const text = "Cached phrase";
  const identity = translationCore.createCacheIdentity({
    context: "interface:button",
    kind: "interface",
    model: "deepseek-v4-flash",
    protectedTerms: [],
    provider: "deepseek",
    sourceLanguage: "auto",
    targetLanguage: "ru",
    text
  });
  const cacheKey = await translationCore.sha256Hex(identity);
  let markDigestStarted;
  let releaseDigest;
  const digestStarted = new Promise((resolve) => {
    markDigestStarted = resolve;
  });
  const digestGate = new Promise((resolve) => {
    releaseDigest = resolve;
  });
  const harness = createHarness({
    async sha256HexImpl(value) {
      markDigestStarted();
      await digestGate;
      return translationCore.sha256Hex(value);
    },
    fetchImpl: async () => createResponse([]),
    storage: {
      translationCacheV1: {
        [cacheKey]: { identity, lastUsed: 0, translation: "Кэшированная фраза" }
      }
    }
  });
  const translation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem(text)
  });

  await Promise.race([
    digestStarted,
    translation.then(() => {
      throw new Error("Translation completed before the digest gate.");
    })
  ]);
  await harness.send({ type: "clearCache" });
  releaseDigest();
  const result = await translation;
  const settings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });

  assert.equal(result.translations[0].text, "Кэшированная фраза");
  assert.equal(settings.cacheEntries, 0);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 0);
});

test("a matching post-clear translation does not reuse the previous generation", async () => {
  let fetchCount = 0;
  let markFirstStarted;
  let markSecondStarted;
  let resolveFirst;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    markSecondStarted = resolve;
  });
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;

      if (fetchCount === 1) {
        markFirstStarted();
        return firstResponse;
      }

      markSecondStarted();
      return createResponse([{ id: "0", text: "Новый перевод" }]);
    }
  });
  const message = { type: "translateBatch", sourceLanguage: "auto", items: translationItem() };
  const oldTranslation = harness.send(message);

  await firstStarted;
  await harness.send({ type: "clearCache" });
  const newTranslation = harness.send(message);
  await secondStarted;
  resolveFirst(createResponse([{ id: "0", text: "Старый перевод" }]));
  const [oldResult, newResult] = await Promise.all([oldTranslation, newTranslation]);
  const stats = await harness.send({ type: "getCacheStats" });

  assert.equal(fetchCount, 2);
  assert.equal(oldResult.translations[0].text, "Старый перевод");
  assert.equal(newResult.translations[0].text, "Новый перевод");
  assert.equal(stats.cacheEntries, 1);
});

test("a post-clear translation is persisted after an older cache write", async () => {
  let releaseFirstWrite;
  let markFirstWriteStarted;
  let cacheWriteCount = 0;
  const firstWriteStarted = new Promise((resolve) => {
    markFirstWriteStarted = resolve;
  });
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      return createResponse([{ id: "0", text: `Перевод ${payload.items[0].text}` }]);
    },
    async storageSet(value, storageData) {
      if (Object.keys(value).some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        cacheWriteCount += 1;

        if (cacheWriteCount === 1) {
          markFirstWriteStarted();
          await firstWriteGate;
        }
      }

      Object.assign(storageData, value);
    }
  });
  const oldTranslation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Old phrase")
  });

  await firstWriteStarted;
  const clear = harness.send({ type: "clearCache" });
  const newTranslation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("New phrase")
  });
  releaseFirstWrite();
  await Promise.all([oldTranslation, clear, newTranslation]);

  const settings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });
  assert.equal(settings.cacheEntries, 1);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 1);
});

test("loads and filters models for each configured provider", async () => {
  const harness = createHarness({
    async fetchImpl(url) {
      assert.equal(url, "https://api.openai.com/v1/models");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: [
              { id: "text-embedding-3-small" },
              { id: "gpt-audio-1.5" },
              { id: "gpt-5.6-sol" },
              { id: "gpt-5.6-luna" }
            ]
          };
        }
      };
    },
    storage: {
      providerApiKeysV1: {
        deepseek: "test-deepseek-api-key-for-background",
        openai: "test-openai-api-key-for-background"
      }
    }
  });

  const response = await harness.send({ type: "listProviderModels", provider: "openai" });
  assert.deepEqual(Array.from(response.models), ["gpt-5.6-luna", "gpt-5.6-sol"]);
});

test("tests the selected model against the chat completions endpoint", async () => {
  const requestedUrls = [];
  const harness = createHarness({
    async fetchImpl(url, options = {}) {
      requestedUrls.push(url);

      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "gpt-5.6-luna" }] };
          }
        };
      }

      const request = JSON.parse(options.body);
      assert.equal(request.model, "gpt-5.6-luna");
      assert.equal(request.stream, false);
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {
        deepseek: "test-deepseek-api-key-for-background",
        openai: "test-openai-api-key-for-background"
      }
    }
  });

  const response = await harness.send({
    type: "testProviderConnection",
    provider: "openai",
    model: "gpt-5.6-luna"
  });

  assert.deepEqual(requestedUrls, [
    "https://api.openai.com/v1/models",
    "https://api.openai.com/v1/chat/completions"
  ]);
  assert.equal(response.model, "gpt-5.6-luna");
});

test("updates the tab badge only from the top frame", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });
  const message = {
    type: "translationStatus",
    status: { error: "", translating: true }
  };

  await harness.send(message, { frameId: 3, tab: { id: 42 } });
  assert.equal(harness.actionCalls.length, 0);

  await harness.send(message, { frameId: 0, tab: { id: 42 } });
  assert.equal(harness.actionCalls.length, 2);
  assert.deepEqual(harness.actionCalls.map(({ options }) => options.tabId), [42, 42]);
});
