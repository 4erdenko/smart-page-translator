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
const CACHE_INDEX_DIRTY_KEY = "translationCacheIndexDirtyV1";
const CACHE_INDEX_KEY = "translationCacheIndexV1";

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

function createFinishReasonResponse(finishReason) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{
          finish_reason: finishReason,
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
  now,
  sha256HexImpl,
  storage = {},
  storageAccessError,
  storageAccessSupported = true,
  storageGet,
  storageRemove,
  storageSet,
  setTimeoutImpl,
  tabGet,
  tabSendMessage
}) {
  let messageListener;
  let commandListener;
  let contextMenuListener;
  let installedListener;
  const actionCalls = [];
  const accessLevelCalls = [];
  const contextMenuCalls = [];
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
      create(options) {
        contextMenuCalls.push({ method: "create", options });
      },
      async remove(id) {
        contextMenuCalls.push({ id, method: "remove" });
      },
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
          const overridden = await storageGet?.(key, storageData);

          if (overridden !== undefined) {
            return overridden;
          }

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
    Date: now
      ? class HarnessDate extends Date {
        static now() {
          return now();
        }
      }
      : Date,
    TextEncoder,
    URL,
    WeakRef,
    browser,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: fetchImpl,
    setTimeout(callback, milliseconds, ...args) {
      const timer = (setTimeoutImpl || setTimeout)(callback, milliseconds, ...args);
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
    contextMenuCalls,
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
      settingsV1: {
        providerDataConsentVersion: 1,
        siteRules: { "https://example.com": "always" },
        version: 4
      },
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
  assert.equal(Object.hasOwn(contentSettings.settings, "siteViewModes"), false);
  assert.equal(contentSettings.settings.selectionButtonEnabled, false);
  assert.equal(contentSettings.site, "https://example.com");
  assert.equal(contentSettings.siteMode, "always");
  assert.equal(contentSettings.settings.viewMode, "translated");
  assert.equal(harness.storageGetKeys.length, 1);

  const uiSettings = await harness.send({
    type: "getSettings",
    site: "https://example.com",
    includeCacheEntries: true
  });
  assert.equal(uiSettings.cacheEntries, 1);
  assert.ok(uiSettings.cacheBytes > 0);
  assert.equal(uiSettings.cacheMaxBytes, translationCore.MAX_CACHE_BYTES);
  assert.equal(uiSettings.settings.contextMenuEnabled, true);
  assert.equal(uiSettings.settings.selectionButtonEnabled, false);
  assert.equal(harness.storageGetKeys.includes(null), true);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 1);
});

test("cold cache lookup reads only the index and calculated phrase key", async () => {
  const text = "Indexed phrase";
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
  const entry = {
    identity,
    lastUsed: Date.now(),
    translation: "Индексированная фраза"
  };
  const index = {
    entries: {
      [cacheKey]: {
        bytes: translationCore.estimateCacheEntryBytes(cacheKey, entry, CACHE_ENTRY_PREFIX),
        lastUsed: entry.lastUsed
      }
    },
    version: 1
  };
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([]);
    },
    storage: {
      [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: entry,
      [CACHE_INDEX_KEY]: index
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem(text)
  }, contentSender());
  const settings = await harness.send({
    type: "getSettings",
    includeCacheEntries: true
  });
  const exactCacheBytes = new TextEncoder().encode(JSON.stringify({
    [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: entry,
    [CACHE_INDEX_KEY]: index
  })).byteLength;

  assert.equal(result.translations[0].text, "Индексированная фраза");
  assert.equal(fetchCount, 0);
  assert.equal(harness.storageGetKeys.includes(null), false);
  assert.ok(harness.storageGetKeys.some((keys) => (
    Array.isArray(keys) && keys.includes(`${CACHE_ENTRY_PREFIX}${cacheKey}`)
  )));
  assert.equal(settings.cacheBytes, exactCacheBytes);
});

test("does not restore a cache entry pruned during its delayed storage read", async () => {
  const text = "Delayed indexed phrase";
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
  const cacheKey = "key-0";
  const entry = {
    identity,
    lastUsed: 0,
    translation: "Устаревшая фраза"
  };
  const indexEntries = Object.fromEntries(Array.from({ length: 101 }, (_, index) => {
    const key = `key-${index}`;
    const indexedEntry = index === 0
      ? entry
      : { identity: `identity-${index}`, lastUsed: index, translation: `translation-${index}` };
    return [
      key,
      {
        bytes: translationCore.estimateCacheEntryBytes(key, indexedEntry, CACHE_ENTRY_PREFIX),
        lastUsed: index
      }
    ];
  }));
  let releaseStorageRead;
  let storageReadStarted;
  const storageReadGate = new Promise((resolve) => {
    releaseStorageRead = resolve;
  });
  const storageReadReady = new Promise((resolve) => {
    storageReadStarted = resolve;
  });
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createFinishReasonResponse("content_filter");
    },
    sha256HexImpl: async () => cacheKey,
    storage: {
      [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: entry,
      [CACHE_INDEX_KEY]: { entries: indexEntries, version: 1 },
      settingsV1: {
        cacheMaxEntries: 101,
        providerDataConsentVersion: 1,
        version: 4
      }
    },
    async storageGet(key, storageData) {
      if (!Array.isArray(key) || !key.includes(`${CACHE_ENTRY_PREFIX}${cacheKey}`)) {
        return undefined;
      }

      const result = { [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: storageData[
        `${CACHE_ENTRY_PREFIX}${cacheKey}`
      ] };
      storageReadStarted();
      await storageReadGate;
      return result;
    }
  });
  const translation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem(text)
  }, contentSender());
  await storageReadReady;
  const settings = await harness.send({
    type: "updateSettings",
    includeCacheEntries: true,
    settings: { cacheMaxEntries: 100 }
  });
  releaseStorageRead();

  await assert.rejects(translation, /content filter/u);
  assert.equal(fetchCount, 1);
  assert.equal(settings.cacheEntries, 100);
  assert.equal(harness.storageData[CACHE_INDEX_DIRTY_KEY], true);
  assert.equal(Object.hasOwn(harness.storageData, `${CACHE_ENTRY_PREFIX}${cacheKey}`), false);
});

test("cache pruning includes serialized index overhead in the hard byte limit", async () => {
  const cacheKey = "a".repeat(64);
  const fixedEntry = { identity: "i", lastUsed: 1, translation: "" };
  const fixedBytes = translationCore.estimateCacheEntryBytes(
    cacheKey,
    fixedEntry,
    CACHE_ENTRY_PREFIX
  );
  const entry = {
    ...fixedEntry,
    translation: "x".repeat(translationCore.MAX_CACHE_BYTES - fixedBytes - 12)
  };
  const entryBytes = translationCore.estimateCacheEntryBytes(
    cacheKey,
    entry,
    CACHE_ENTRY_PREFIX
  );
  const index = {
    entries: {
      [cacheKey]: { bytes: entryBytes, lastUsed: 1 }
    },
    version: 1
  };
  const dataBytes = 2 + entryBytes;
  const totalBytes = new TextEncoder().encode(JSON.stringify({
    [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: entry,
    [CACHE_INDEX_KEY]: index
  })).byteLength;
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      [`${CACHE_ENTRY_PREFIX}${cacheKey}`]: entry,
      [CACHE_INDEX_KEY]: index,
      settingsV1: {
        providerDataConsentVersion: 1,
        version: 4
      }
    }
  });
  const settings = await harness.send({
    type: "getSettings",
    includeCacheEntries: true
  });

  assert.ok(dataBytes < translationCore.MAX_CACHE_BYTES);
  assert.ok(totalBytes > translationCore.MAX_CACHE_BYTES);
  assert.equal(settings.cacheEntries, 0);
  assert.equal(Object.hasOwn(harness.storageData, `${CACHE_ENTRY_PREFIX}${cacheKey}`), false);
});

test("reports persisted index bytes until a pruned cache index is flushed", async () => {
  const cache = Object.fromEntries(Array.from({ length: 101 }, (_, index) => {
    const key = `${String(index).padStart(3, "0")}-${"a".repeat(60)}`;
    return [
      key,
      {
        identity: `identity-${index}`,
        lastUsed: index,
        translation: `translation-${index}`
      }
    ];
  }));
  const index = {
    entries: Object.fromEntries(Object.entries(cache).map(([key, entry]) => [
      key,
      {
        bytes: translationCore.estimateCacheEntryBytes(key, entry, CACHE_ENTRY_PREFIX),
        lastUsed: entry.lastUsed
      }
    ])),
    version: 1
  };
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      ...Object.fromEntries(Object.entries(cache).map(([key, entry]) => [
        `${CACHE_ENTRY_PREFIX}${key}`,
        entry
      ])),
      [CACHE_INDEX_KEY]: index,
      settingsV1: {
        cacheMaxEntries: 100,
        providerDataConsentVersion: 1,
        version: 4
      }
    }
  });
  const settings = await harness.send({
    type: "getSettings",
    includeCacheEntries: true
  });
  const physicalCache = Object.fromEntries(Object.entries(harness.storageData)
    .filter(([key]) => (
      key === CACHE_INDEX_KEY
      || key === CACHE_INDEX_DIRTY_KEY
      || key.startsWith(CACHE_ENTRY_PREFIX)
    )));
  const physicalBytes = new TextEncoder().encode(JSON.stringify(physicalCache)).byteLength;

  assert.equal(settings.cacheEntries, 100);
  assert.equal(settings.cacheBytes, physicalBytes);
  assert.equal(harness.storageData[CACHE_INDEX_DIRTY_KEY], true);
});

test("clears a legacy cache after its migration write fails", async () => {
  let migrationAttempted = false;
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      translationCacheV1: {
        legacy: {
          identity: "legacy-identity",
          lastUsed: 1,
          translation: "Старый перевод"
        }
      }
    },
    async storageSet(value, storageData) {
      if (!migrationAttempted
        && Object.keys(value).some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        migrationAttempted = true;
        throw new Error("Legacy migration failed.");
      }

      Object.assign(storageData, value);
    }
  });

  await assert.rejects(
    harness.send({ type: "getCacheStats" }),
    /Legacy migration failed/u
  );
  await harness.send({ type: "clearCache" });

  assert.equal(migrationAttempted, true);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.deepEqual({ ...harness.storageData[CACHE_INDEX_KEY].entries }, {});
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 0);
});

test("retries cache initialization in the same background after a migration write fails", async () => {
  let migrationAttempts = 0;
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      translationCacheV1: {
        legacy: {
          identity: "legacy-identity",
          lastUsed: 1,
          translation: "Старый перевод"
        }
      }
    },
    async storageSet(value, storageData) {
      if (Object.keys(value).some((key) => key.startsWith(CACHE_ENTRY_PREFIX))) {
        migrationAttempts += 1;

        if (migrationAttempts === 1) {
          throw new Error("Legacy migration failed.");
        }
      }

      Object.assign(storageData, value);
    }
  });

  await assert.rejects(
    harness.send({ type: "getCacheStats" }),
    /Legacy migration failed/u
  );
  const stats = await harness.send({ type: "getCacheStats" });

  assert.equal(stats.cacheEntries, 1);
  assert.equal(migrationAttempts, 2);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
});

test("retries legacy cache cleanup in the same background after its migration write succeeds", async () => {
  let legacyRemoveAttempts = 0;
  const storageRemove = async (keys, storageData) => {
    const storageKeys = Array.isArray(keys) ? keys : [keys];

    if (storageKeys.includes("translationCacheV1")) {
      legacyRemoveAttempts += 1;

      if (legacyRemoveAttempts === 1) {
        throw new Error("Legacy cleanup failed.");
      }
    }

    for (const storageKey of storageKeys) {
      delete storageData[storageKey];
    }
  };
  const firstHarness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      translationCacheV1: {
        legacy: {
          identity: "legacy-identity",
          lastUsed: 1,
          translation: "Старый перевод"
        }
      }
    },
    storageRemove
  });

  await assert.rejects(
    firstHarness.send({ type: "getCacheStats" }),
    /Legacy cleanup failed/u
  );
  assert.equal(Object.hasOwn(firstHarness.storageData, "translationCacheV1"), true);
  assert.equal(Object.hasOwn(firstHarness.storageData, CACHE_INDEX_KEY), true);
  assert.equal(
    Object.hasOwn(firstHarness.storageData, `${CACHE_ENTRY_PREFIX}legacy`),
    true
  );

  const stats = await firstHarness.send({ type: "getCacheStats" });

  assert.equal(stats.cacheEntries, 1);
  assert.equal(legacyRemoveAttempts, 2);
  assert.equal(Object.hasOwn(firstHarness.storageData, "translationCacheV1"), false);
  assert.equal(firstHarness.storageGetKeys.includes(null), true);
  assert.deepEqual(
    [...firstHarness.storageGetKeys.slice(-1)[0]],
    [CACHE_INDEX_KEY, CACHE_INDEX_DIRTY_KEY, "translationCacheV1"]
  );
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
  assert.equal(harness.storageData.settingsV1.providerDataConsentVersion, 1);
  assert.equal(harness.storageData.settingsV1.version, 4);
});

test("preserves an explicit 8,000 phrase cache limit from settings version 2", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        cacheMaxEntries: 8000,
        version: 2
      }
    }
  });
  const response = await harness.send({ type: "getSettings" });

  assert.equal(response.settings.cacheMaxEntries, 8000);
  assert.equal(harness.storageData.settingsV1.cacheMaxEntries, 8000);
  assert.equal(harness.storageData.settingsV1.providerDataConsentVersion, 1);
  assert.equal(harness.storageData.settingsV1.version, 4);
});

test("serializes lazy settings migration with concurrent settings updates", async () => {
  let markMigrationStarted;
  const migrationStarted = new Promise((resolve) => {
    markMigrationStarted = resolve;
  });
  let migrationPaused = false;
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        providerDataConsentVersion: 0,
        siteRules: {},
        targetLanguage: "ru",
        version: 3
      }
    },
    async storageSet(value, storageData) {
      if (!migrationPaused
        && value.settingsV1?.version === 4
        && value.settingsV1?.targetLanguage === "ru") {
        migrationPaused = true;
        markMigrationStarted();
        await new Promise((resolve) => setImmediate(resolve));
      }

      Object.assign(storageData, value);
    }
  });
  const settingsRead = harness.send({ type: "getSettings" });
  await migrationStarted;
  const settingsUpdate = harness.send({
    type: "updateSettings",
    settings: {
      siteRules: { "https://example.com": "never" },
      targetLanguage: "en"
    }
  });

  await Promise.all([settingsRead, settingsUpdate]);

  assert.equal(harness.storageData.settingsV1.providerDataConsentVersion, 1);
  assert.equal(harness.storageData.settingsV1.targetLanguage, "en");
  assert.equal(harness.storageData.settingsV1.version, 4);
  assert.deepEqual(
    { ...harness.storageData.settingsV1.siteRules },
    { "https://example.com": "never" }
  );
});

test("resolves the global translation view and per-site overrides", async () => {
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      settingsV1: {
        defaultViewMode: "bilingual",
        siteViewModes: {
          "https://example.com": "translated",
          "javascript:invalid": "bilingual",
          "https://invalid-view.example": "original"
        },
        version: 2
      }
    }
  });

  const siteSettings = await harness.send(
    { type: "getSettings" },
    contentSender("https://example.com/page")
  );
  const defaultSettings = await harness.send(
    { type: "getSettings" },
    contentSender("https://other.example/page")
  );
  const uiSettings = await harness.send({
    type: "getSettings",
    site: "https://example.com"
  });

  assert.equal(siteSettings.settings.viewMode, "translated");
  assert.equal(defaultSettings.settings.viewMode, "bilingual");
  assert.equal(uiSettings.settings.defaultViewMode, "bilingual");
  assert.equal(uiSettings.siteViewMode, "translated");
  assert.deepEqual(
    { ...harness.storageData.settingsV1.siteViewModes },
    { "https://example.com": "translated" }
  );
});

test("opens onboarding once for a new installation", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  await harness.install({ reason: "install", temporary: false });

  assert.equal(harness.storageData.settingsV1.cacheMaxEntries, 16000);
  assert.equal(harness.storageData.settingsV1.contextMenuEnabled, true);
  assert.equal(harness.storageData.settingsV1.selectionButtonEnabled, false);
  assert.equal(harness.storageData.onboardingShownVersion, 4);
  assert.equal(harness.createdTabs.length, 1);
  assert.equal(
    harness.createdTabs[0].url,
    "chrome-extension://test/onboarding/onboarding.html"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.contextMenuCalls.at(-1))),
    {
      method: "create",
      options: {
        contexts: ["selection", "editable"],
        id: "translate-text",
        title: "Translate text"
      }
    }
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
    menuItemId: "translate-text",
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

test("routes the native context-menu command from editable fields", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  harness.sendContextMenu({
    editable: true,
    frameId: 2,
    menuItemId: "translate-text",
    selectionText: "Private draft"
  }, { id: 21 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(harness.tabMessages.at(-1))), {
    message: { type: "translateEditable" },
    options: { frameId: 2 },
    tabId: 21
  });
});

test("adds and removes the native translation command from settings", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  const disabledSettings = await harness.send({
    type: "updateSettings",
    settings: {
      contextMenuEnabled: false,
      selectionButtonEnabled: true
    }
  });
  const contentSettings = await harness.send(
    { type: "getSettings" },
    contentSender()
  );
  assert.equal(disabledSettings.settings.contextMenuEnabled, false);
  assert.equal(disabledSettings.settings.selectionButtonEnabled, true);
  assert.equal(contentSettings.settings.selectionButtonEnabled, true);
  assert.equal(
    harness.contextMenuCalls.filter(({ method }) => method === "create").length,
    0
  );
  assert.deepEqual(
    harness.contextMenuCalls.filter(({ method }) => method === "remove").map(({ id }) => id),
    ["translate-text", "translate-selection", "translate-editable"]
  );

  await harness.send({
    type: "updateSettings",
    settings: { contextMenuEnabled: true }
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.contextMenuCalls.at(-1))),
    {
      method: "create",
      options: {
        contexts: ["selection", "editable"],
        id: "translate-text",
        title: "Translate text"
      }
    }
  );
});

test("keeps the native command aligned with the latest overlapping settings save", async () => {
  let releaseFirstBroadcast;
  let resolveFirstBroadcastStarted;
  let broadcastCount = 0;
  const firstBroadcastStarted = new Promise((resolve) => {
    resolveFirstBroadcastStarted = resolve;
  });
  const firstBroadcastGate = new Promise((resolve) => {
    releaseFirstBroadcast = resolve;
  });
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    async tabSendMessage(_tabId, message) {
      if (message.type !== "settingsChanged") {
        return;
      }

      broadcastCount += 1;

      if (broadcastCount === 1) {
        resolveFirstBroadcastStarted();
        await firstBroadcastGate;
      }
    }
  });
  const disablePromise = harness.send({
    type: "updateSettings",
    settings: { contextMenuEnabled: false }
  });
  await firstBroadcastStarted;
  const enablePromise = harness.send({
    type: "updateSettings",
    settings: { contextMenuEnabled: true }
  });
  await enablePromise;
  releaseFirstBroadcast();
  await disablePromise;

  assert.equal(harness.storageData.settingsV1.contextMenuEnabled, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.contextMenuCalls.at(-1))),
    {
      method: "create",
      options: {
        contexts: ["selection", "editable"],
        id: "translate-text",
        title: "Translate text"
      }
    }
  );
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
        defaultViewMode: "bilingual",
        siteRules: {
          "https://example.com": "always",
          "https://trusted-frame.example": "always"
        },
        siteViewModes: {
          "https://example.com": "translated"
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
  assert.equal(sameOriginFrame.settings.viewMode, "translated");
  assert.equal(thirdPartyFrame.site, "https://third-party.example");
  assert.equal(thirdPartyFrame.siteMode, "never");
  assert.equal(thirdPartyFrame.settings.viewMode, "bilingual");
  assert.equal(trustedFrame.siteMode, "always");
  assert.equal(trustedFrame.settings.viewMode, "bilingual");
  assert.equal(inheritedBlankFrame.site, "https://example.com");
  assert.equal(inheritedBlankFrame.siteMode, "always");
  assert.equal(inheritedBlankFrame.settings.viewMode, "translated");
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
    storage: {
      settingsV1: {
        providerDataConsentVersion: 1,
        version: 4
      }
    },
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
    { type: "configureProvider", provider: "deepseek", apiKey: "candidate-api-key-for-background" },
    { type: "getCacheStats" },
    { type: "listProviderModels", provider: "deepseek" },
    { type: "setSiteMode", site: "https://example.com", mode: "always" },
    { type: "setSiteViewMode", site: "https://example.com", viewMode: "bilingual" },
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

test("saves and clears a per-site translation view", async () => {
  const harness = createHarness({ fetchImpl: async () => createResponse([]) });

  const selected = await harness.send({
    type: "setSiteViewMode",
    site: "https://example.com/path",
    tabId: 7,
    viewMode: "bilingual"
  });
  assert.equal(selected.siteViewMode, "bilingual");
  assert.equal(harness.storageData.settingsV1.siteViewModes["https://example.com"], "bilingual");

  const inherited = await harness.send({
    type: "setSiteViewMode",
    site: "https://example.com",
    tabId: 7,
    viewMode: "default"
  });
  assert.equal(inherited.siteViewMode, "default");
  assert.equal(harness.storageData.settingsV1.siteViewModes["https://example.com"], undefined);
});

test("does not persist translation views selected from a private tab", async () => {
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
      type: "setSiteViewMode",
      site: "https://example.com",
      tabId: 7,
      viewMode: "bilingual"
    }),
    /private tabs/u
  );
  assert.equal(harness.storageData.settingsV1?.siteViewModes?.["https://example.com"], undefined);
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

test("allows the first provider request to use the full translation deadline", async () => {
  const timeoutDurations = [];
  const harness = createHarness({
    async fetchImpl() {
      return createResponse([{ id: "0", text: "Перевод в пределах срока" }]);
    },
    now: () => 1000,
    setTimeoutImpl(callback, milliseconds, ...args) {
      timeoutDurations.push(milliseconds);
      return setTimeout(callback, milliseconds, ...args);
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Deadline-sized phrase")
  }, contentSender());

  assert.equal(result.translations[0].text, "Перевод в пределах срока");
  assert.equal(timeoutDurations.includes(28000), true);
  assert.equal(timeoutDurations.includes(18000), false);
});

test("does not retry a provider request after the total deadline timeout", async () => {
  let currentTime = 1000;
  let fetchCount = 0;
  const timeoutDurations = [];
  const harness = createHarness({
    fetchImpl(_url, options) {
      fetchCount += 1;
      return new Promise((resolve, reject) => {
        const rejectTimeout = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (options.signal.aborted) {
          rejectTimeout();
        } else {
          options.signal.addEventListener("abort", rejectTimeout, { once: true });
        }
      });
    },
    now: () => currentTime,
    setTimeoutImpl(callback, milliseconds, ...args) {
      timeoutDurations.push(milliseconds);

      if (milliseconds === 28000) {
        queueMicrotask(() => {
          currentTime += milliseconds;
          callback(...args);
        });
      }

      return {};
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      persistCache: false,
      sourceLanguage: "auto",
      items: translationItem("Slow provider phrase")
    }, contentSender()),
    /timed out/u
  );
  assert.equal(fetchCount, 1);
  assert.deepEqual(timeoutDurations, [28000]);
});

test("honors Retry-After before retrying with jitter", async () => {
  const attempts = [];
  const harness = createHarness({
    async fetchImpl() {
      attempts.push(Date.now());

      if (attempts.length === 1) {
        return {
          headers: {
            get(name) {
              return name.toLowerCase() === "retry-after" ? "0.05" : null;
            }
          },
          ok: false,
          status: 429
        };
      }

      return createResponse([{ id: "0", text: "Повтор после паузы" }]);
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Retry after phrase")
  }, contentSender());

  assert.equal(result.translations[0].text, "Повтор после паузы");
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1] - attempts[0] >= 45);
});

test("opens a short provider circuit only after repeated completed transient failures", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return {
        headers: {
          get(name) {
            return name.toLowerCase() === "retry-after" ? "60" : null;
          }
        },
        ok: false,
        status: 503
      };
    }
  });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      harness.send({
        type: "translateBatch",
        persistCache: false,
        sourceLanguage: "auto",
        items: translationItem(`Circuit failure ${index}`)
      }, contentSender()),
      /temporarily returned HTTP 503/u
    );
  }

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      persistCache: false,
      sourceLanguage: "auto",
      items: translationItem("Circuit blocked request")
    }, contentSender()),
    /temporarily unavailable after repeated failures/u
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

test("refreshes policy after a suspended page is restored from the back-forward cache", () => {
  const activeStart = contentSource.indexOf("function isTranslationViewActive()");
  const activeEnd = contentSource.indexOf("function createWeakReference(", activeStart);
  const activeHandler = contentSource.slice(activeStart, activeEnd);
  const pageShowStart = contentSource.indexOf("function handlePageShow()");
  const pageShowEnd = contentSource.indexOf("function handleViewportMovement()", pageShowStart);
  const pageShowHandler = contentSource.slice(pageShowStart, pageShowEnd);

  assert.match(activeHandler, /&& !pageSuspended/u);
  assert.match(activeHandler, /&& activePolicyRefreshCount === 0/u);
  assert.match(contentSource, /window\.addEventListener\("pagehide", \(\) => \{\s+pageSuspended = true;/u);
  assert.match(
    pageShowHandler,
    /if \(wasSuspended\) \{\s+checkRouteChange\(\);\s+pageSuspended = false;\s+void refreshPolicy\(\);/u
  );
  assert.match(contentSource, /activePolicyRefreshCount \+= 1;/u);
  assert.match(
    contentSource,
    /activePolicyRefreshCount = Math\.max\(0, activePolicyRefreshCount - 1\);[\s\S]*if \(activePolicyRefreshCount === 0\)/u
  );
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

test("discovers brand terms before each scan queues its content", () => {
  const scanStart = contentSource.indexOf("function scanDocument()");
  const scanEnd = contentSource.indexOf("function scanSubtree(", scanStart);
  const documentScan = contentSource.slice(scanStart, scanEnd);
  const batchStart = contentSource.indexOf("function takeBatch(");
  const batchEnd = contentSource.indexOf("function trackTextNode(", batchStart);
  const takeBatch = contentSource.slice(batchStart, batchEnd);

  assert.match(documentScan, /let scanPhase = "brands";/u);
  assert.match(documentScan, /scanPhase === "brands"[\s\S]*collectBrandNode\(node\)/u);
  assert.match(contentSource, /const brandElement = findClosestTextKindElement\(element, "brand-name"\);/u);
  assert.match(takeBatch, /const termIndex = getProtectedTermIndex\(\);/u);
  assert.match(takeBatch, /segment\.protectedTerms = selectProtectedTerms\(/u);
  assert.ok((contentSource.match(/selectProtectedTerms\(/gu) || []).length >= 2);
  assert.match(contentSource, /const textKind = getInheritedTextKind\(node\.parentElement\);/u);
  assert.match(contentSource, /activeBrandScanCount \+= 1;/u);
  assert.match(contentSource, /activeBrandScanCount = Math\.max\(0, activeBrandScanCount - 1\);/u);
  assert.match(contentSource, /while \(activeBrandScanCount === 0[\s\S]*pendingSegments\.size > 0\)/u);
  assert.match(contentSource, /if \(activeBrandScanCount > 0[\s\S]*pendingSegments\.size === 0\)/u);
  assert.match(
    contentSource,
    /if \(node\?\.nodeType === Node\.TEXT_NODE && !hasMeaningfulText\(node\.nodeValue\)\) \{\s+return;/u
  );
});

test("counts filtered text and element traversal inside scan budgets", () => {
  const filterStart = contentSource.indexOf("function acceptScanNode(");
  const filterEnd = contentSource.indexOf("function observeRoot(", filterStart);
  const filter = contentSource.slice(filterStart, filterEnd);
  const sampleStart = contentSource.indexOf("async function getLanguageSample()");
  const sampleEnd = contentSource.indexOf("async function detectPageLanguage()", sampleStart);
  const sample = contentSource.slice(sampleStart, sampleEnd);

  assert.match(filter, /shouldPruneScanNode\(node, Node\.ELEMENT_NODE\)/u);
  assert.doesNotMatch(filter, /node\.nodeType === Node\.TEXT_NODE/u);
  assert.match(sample, /NodeFilter\.SHOW_ELEMENT \| NodeFilter\.SHOW_TEXT/u);
  assert.match(sample, /if \(node\.nodeType === Node\.TEXT_NODE/u);
});

test("cancels stale translation requests when pending page work is cleared", () => {
  const handlerStart = contentSource.indexOf("function clearPending()");
  const handlerEnd = contentSource.indexOf("function removeMotion()", handlerStart);
  const handler = contentSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /cancelActiveTranslations\(\);/u);
  assert.match(contentSource, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*clearPending\(\);/u);
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
  assert.match(
    contentSource,
    /preferredViewMode: \["bilingual", "translated"\]\.includes\(settings\?\.viewMode\)[\s\S]*preferredViewModeChanged[\s\S]*await showActiveView\(next\.preferredViewMode\);/u
  );
  assert.match(
    contentSource,
    /if \(!next\.enabled \|\| !wasEnabled\) \{\s+state\.viewMode = next\.preferredViewMode;\s+lastActiveViewMode = next\.preferredViewMode;/u
  );
  assert.match(
    contentSource,
    /if \(message\?\.type === "cycleViewMode"\) \{\s+if \(!state\.enabled\) \{\s+return enableTranslation\(\);/u
  );
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

test("the optional selection button is disabled by default and removed on excluded websites", () => {
  const settingsStart = contentSource.indexOf("async function applySettings(");
  const settingsEnd = contentSource.indexOf("async function applyPolicy(", settingsStart);
  const settingsHandler = contentSource.slice(settingsStart, settingsEnd);
  const closeActionStart = contentSource.indexOf("function closeSelectionAction()");
  const closeActionEnd = contentSource.indexOf("function ensureSelectionRoot()", closeActionStart);
  const closeActionHandler = contentSource.slice(closeActionStart, closeActionEnd);
  const syncStart = contentSource.indexOf("function syncSelectionButtonListener()");
  const syncEnd = contentSource.indexOf("function handleSelectionPointerDown(", syncStart);
  const syncHandler = contentSource.slice(syncStart, syncEnd);
  const initializationStart = contentSource.indexOf(
    'document.addEventListener("visibilitychange"'
  );
  const initialization = contentSource.slice(initializationStart);

  assert.match(contentSource, /selectionButtonEnabled: false/u);
  assert.match(
    settingsHandler,
    /selectionButtonEnabled: settings\?\.selectionButtonEnabled === true/u
  );
  assert.match(
    syncHandler,
    /state\.selectionButtonEnabled && state\.siteMode !== "never"/u
  );
  assert.match(closeActionHandler, /selectionRoot\?\.querySelector\("\.action"\)/u);
  assert.match(syncHandler, /closeSelectionAction\(\)/u);
  assert.doesNotMatch(syncHandler, /closeSelectionUi\(\)/u);
  assert.match(syncHandler, /document\.removeEventListener\("pointerup"/u);
  assert.doesNotMatch(initialization, /document\.addEventListener\("pointerup"/u);
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

test("persists changed entries without rewriting the full index after each batch", async () => {
  const cacheWrites = [];
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      return createResponse([{ id: "0", text: `Перевод ${payload.items[0].text}` }]);
    },
    storage: {
      [CACHE_INDEX_KEY]: { entries: {}, version: 1 }
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
  assert.ok(cacheWrites.every((keys) => !keys.includes(CACHE_INDEX_KEY)));
  assert.equal(harness.storageData[CACHE_INDEX_DIRTY_KEY], true);
  assert.equal(Object.hasOwn(harness.storageData, "translationCacheV1"), false);
  assert.equal(Object.keys(getStoredCache(harness.storageData)).length, 2);
});

test("flushes the full cache index once after a burst of entry writes", async () => {
  let flushCacheIndex;
  let indexWriteCount = 0;
  let markerWriteCount = 0;
  let markIndexWritten;
  let markIndexCleaned;
  const indexWritten = new Promise((resolve) => {
    markIndexWritten = resolve;
  });
  const indexCleaned = new Promise((resolve) => {
    markIndexCleaned = resolve;
  });
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      return createResponse([{ id: "0", text: `Перевод ${payload.items[0].text}` }]);
    },
    setTimeoutImpl(callback, milliseconds, ...args) {
      const timer = setTimeout(callback, milliseconds, ...args);

      if (milliseconds === 15000) {
        flushCacheIndex = () => {
          clearTimeout(timer);
          callback(...args);
        };
      }

      return timer;
    },
    storage: {
      [CACHE_INDEX_KEY]: { entries: {}, version: 1 }
    },
    async storageRemove(key, storageData) {
      const keys = Array.isArray(key) ? key : [key];

      for (const storageKey of keys) {
        delete storageData[storageKey];
      }

      if (keys.includes(CACHE_INDEX_DIRTY_KEY)) {
        markIndexCleaned();
      }
    },
    async storageSet(value, storageData) {
      Object.assign(storageData, value);

      if (Object.hasOwn(value, CACHE_INDEX_KEY)) {
        indexWriteCount += 1;
        markIndexWritten();
      }

      if (Object.hasOwn(value, CACHE_INDEX_DIRTY_KEY)) {
        markerWriteCount += 1;
      }
    }
  });

  await harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem("First phrase") });
  await harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem("Second phrase") });

  assert.equal(indexWriteCount, 0);
  assert.equal(markerWriteCount, 1);
  assert.equal(typeof flushCacheIndex, "function");
  flushCacheIndex();
  await Promise.all([indexWritten, indexCleaned]);

  assert.equal(indexWriteCount, 1);
  assert.equal(Object.keys(harness.storageData[CACHE_INDEX_KEY].entries).length, 2);
  assert.equal(Object.hasOwn(harness.storageData, CACHE_INDEX_DIRTY_KEY), false);
});

test("flushes cache changes queued while the dirty marker is being removed", async () => {
  let flushCacheIndex;
  let releaseFirstCleanup;
  let markFirstCleanupStarted;
  let markSecondResponseHandled;
  let markSecondCleanupFinished;
  const firstCleanupGate = new Promise((resolve) => {
    releaseFirstCleanup = resolve;
  });
  const firstCleanupStarted = new Promise((resolve) => {
    markFirstCleanupStarted = resolve;
  });
  const secondResponseHandled = new Promise((resolve) => {
    markSecondResponseHandled = resolve;
  });
  const secondCleanupFinished = new Promise((resolve) => {
    markSecondCleanupFinished = resolve;
  });
  let cleanupCount = 0;
  const harness = createHarness({
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      const payload = JSON.parse(request.messages[1].content);
      const response = createResponse([{ id: "0", text: `Перевод ${payload.items[0].text}` }]);

      if (payload.items[0].text === "Second phrase") {
        const readBody = response.json;
        response.json = async () => {
          const body = await readBody();
          setImmediate(markSecondResponseHandled);
          return body;
        };
      }

      return response;
    },
    setTimeoutImpl(callback, milliseconds, ...args) {
      const timer = setTimeout(callback, milliseconds, ...args);

      if (milliseconds === 15000) {
        flushCacheIndex = () => {
          clearTimeout(timer);
          callback(...args);
        };
      }

      return timer;
    },
    storage: {
      [CACHE_INDEX_KEY]: { entries: {}, version: 1 }
    },
    async storageRemove(key, storageData) {
      const keys = Array.isArray(key) ? key : [key];

      if (keys.includes(CACHE_INDEX_DIRTY_KEY)) {
        cleanupCount += 1;

        if (cleanupCount === 1) {
          markFirstCleanupStarted();
          await firstCleanupGate;
        }
      }

      for (const storageKey of keys) {
        delete storageData[storageKey];
      }

      if (cleanupCount === 2) {
        markSecondCleanupFinished();
      }
    }
  });

  await harness.send({ type: "translateBatch", sourceLanguage: "auto", items: translationItem("First phrase") });
  flushCacheIndex();
  await firstCleanupStarted;
  const secondTranslation = harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Second phrase")
  });
  await secondResponseHandled;
  releaseFirstCleanup();
  await secondTranslation;

  flushCacheIndex();
  await secondCleanupFinished;

  assert.equal(cleanupCount, 2);
  assert.equal(Object.keys(harness.storageData[CACHE_INDEX_KEY].entries).length, 2);
  assert.equal(Object.hasOwn(harness.storageData, CACHE_INDEX_DIRTY_KEY), false);
});

test("rebuilds a cache index left dirty by an interrupted deferred flush", async () => {
  const firstEntry = {
    identity: "first-identity",
    lastUsed: 1,
    translation: "Первый"
  };
  const secondEntry = {
    identity: "second-identity",
    lastUsed: 2,
    translation: "Второй"
  };
  let shardWriteCount = 0;
  const harness = createHarness({
    fetchImpl: async () => createResponse([]),
    storage: {
      [`${CACHE_ENTRY_PREFIX}first`]: firstEntry,
      [`${CACHE_ENTRY_PREFIX}second`]: secondEntry,
      [CACHE_INDEX_DIRTY_KEY]: true,
      [CACHE_INDEX_KEY]: {
        entries: {
          first: {
            bytes: translationCore.estimateCacheEntryBytes("first", firstEntry, CACHE_ENTRY_PREFIX),
            lastUsed: 1
          }
        },
        version: 1
      }
    },
    async storageSet(value, storageData) {
      shardWriteCount += Object.keys(value)
        .filter((key) => key.startsWith(CACHE_ENTRY_PREFIX))
        .length;
      Object.assign(storageData, value);
    }
  });
  const stats = await harness.send({ type: "getCacheStats" });

  assert.equal(stats.cacheEntries, 2);
  assert.equal(shardWriteCount, 0);
  assert.deepEqual(
    Object.keys(harness.storageData[CACHE_INDEX_KEY].entries).sort(),
    ["first", "second"]
  );
  assert.equal(Object.hasOwn(harness.storageData, CACHE_INDEX_DIRTY_KEY), false);
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

test("retries a transient provider finish reason once", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return fetchCount === 1
        ? createFinishReasonResponse("server_error")
        : createResponse([{ id: "0", text: "Успешный повтор" }]);
    }
  });
  const result = await harness.send({
    type: "translateBatch",
    sourceLanguage: "auto",
    items: translationItem("Transient finish")
  }, contentSender());

  assert.equal(result.translations[0].text, "Успешный повтор");
  assert.equal(fetchCount, 2);
});

test("surfaces provider content filtering without retrying", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createFinishReasonResponse("content_filter");
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Filtered phrase")
    }, contentSender()),
    /content filter/u
  );
  assert.equal(fetchCount, 1);
});

test("shares one total deadline across transient provider response retries", async () => {
  let currentTime = 1000;
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      currentTime += 28001;
      return createFinishReasonResponse("server_error");
    },
    now() {
      return currentTime;
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Deadline phrase")
    }, contentSender()),
    /deadline expired/u
  );
  assert.equal(fetchCount, 1);
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

test("requires explicit versioned consent before saving or probing a new provider key", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {},
      settingsV1: {
        providerDataConsentVersion: 0,
        version: 4
      }
    }
  });

  await assert.rejects(
    harness.send({
      type: "configureProvider",
      apiKey: "candidate-deepseek-api-key-for-background",
      provider: "deepseek",
      targetLanguage: "ru"
    }),
    /Confirm the current provider data disclosure/u
  );
  await assert.rejects(
    harness.send({
      type: "updateProviderKey",
      action: "set",
      apiKey: "candidate-deepseek-api-key-for-background",
      provider: "deepseek"
    }),
    /Confirm the current provider data disclosure/u
  );

  assert.equal(fetchCount, 0);
  assert.equal(harness.storageData.providerApiKeysV1.deepseek, undefined);
});

test("serializes provider consent with concurrent settings updates", async () => {
  let releaseProviderWrite;
  let providerWriteStarted;
  const providerWriteGate = new Promise((resolve) => {
    releaseProviderWrite = resolve;
  });
  const providerWriteReady = new Promise((resolve) => {
    providerWriteStarted = resolve;
  });
  let providerWritePaused = false;
  const harness = createHarness({
    async fetchImpl() {
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {},
      settingsV1: {
        providerDataConsentVersion: 0,
        siteRules: {},
        targetLanguage: "ru",
        version: 4
      }
    },
    async storageSet(value, storageData) {
      if (!providerWritePaused
        && Object.hasOwn(value, "providerApiKeysV1")
        && Object.hasOwn(value, "settingsV1")) {
        providerWritePaused = true;
        providerWriteStarted();
        await providerWriteGate;
      }

      Object.assign(storageData, value);
    }
  });
  const providerUpdate = harness.send({
    type: "updateProviderKey",
    action: "set",
    apiKey: "candidate-deepseek-api-key-for-background",
    provider: "deepseek",
    providerDataConsent: true,
    providerDataConsentVersion: 1
  });
  await providerWriteReady;
  const settingsUpdate = harness.send({
    type: "updateSettings",
    settings: {
      siteRules: { "https://example.com": "never" },
      targetLanguage: "en"
    }
  });
  releaseProviderWrite();
  await Promise.all([providerUpdate, settingsUpdate]);

  assert.equal(
    harness.storageData.providerApiKeysV1.deepseek,
    "candidate-deepseek-api-key-for-background"
  );
  assert.equal(harness.storageData.settingsV1.providerDataConsentVersion, 1);
  assert.equal(harness.storageData.settingsV1.targetLanguage, "en");
  assert.deepEqual(
    { ...harness.storageData.settingsV1.siteRules },
    { "https://example.com": "never" }
  );
});

test("does not contact a provider when stored data consent is missing", async () => {
  let fetchCount = 0;
  const harness = createHarness({
    async fetchImpl() {
      fetchCount += 1;
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {
        deepseek: "stored-deepseek-api-key-for-background"
      },
      settingsV1: {
        provider: "deepseek",
        providerDataConsentVersion: 0,
        version: 4
      }
    }
  });

  await assert.rejects(
    harness.send({
      type: "translateBatch",
      sourceLanguage: "auto",
      items: translationItem("Consent-gated phrase")
    }, contentSender()),
    /Provider data consent is required/u
  );
  assert.equal(fetchCount, 0);
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

test("configures a verified provider and selects its preferred available model", async () => {
  const candidateKey = "candidate-deepseek-api-key-for-background";
  const requestedUrls = [];
  const harness = createHarness({
    async fetchImpl(url, options = {}) {
      requestedUrls.push(url);
      assert.equal(options.headers.Authorization, `Bearer ${candidateKey}`);

      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: [
                { id: "deepseek-v4-pro" },
                { id: "deepseek-v4-flash" }
              ]
            };
          }
        };
      }

      const request = JSON.parse(options.body);
      assert.equal(request.model, "deepseek-v4-flash");
      assert.deepEqual(request.thinking, { type: "disabled" });
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {},
      settingsV1: {
        provider: "openai",
        providerModels: {
          deepseek: "deepseek-v4-flash",
          openai: "gpt-5.6-luna"
        },
        targetLanguage: "en",
        version: 2
      }
    }
  });

  const response = await harness.send({
    type: "configureProvider",
    apiKey: candidateKey,
    provider: "deepseek",
    providerDataConsent: true,
    providerDataConsentVersion: 1,
    targetLanguage: "ru"
  });

  assert.deepEqual(requestedUrls, [
    "https://api.deepseek.com/models",
    "https://api.deepseek.com/chat/completions"
  ]);
  assert.equal(response.model, "deepseek-v4-flash");
  assert.deepEqual(Array.from(response.models), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(harness.storageData.providerApiKeysV1.deepseek, candidateKey);
  assert.equal(harness.storageData.settingsV1.provider, "deepseek");
  assert.equal(harness.storageData.settingsV1.providerDataConsentVersion, 1);
  assert.equal(harness.storageData.settingsV1.providerModels.deepseek, "deepseek-v4-flash");
  assert.equal(harness.storageData.settingsV1.targetLanguage, "ru");
});

test("reuses a stored provider key when the onboarding field is blank", async () => {
  const storedKey = "stored-deepseek-api-key-for-background";
  const harness = createHarness({
    async fetchImpl(url, options = {}) {
      assert.equal(options.headers.Authorization, `Bearer ${storedKey}`);

      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "deepseek-v4-flash" }] };
          }
        };
      }

      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: { deepseek: storedKey }
    }
  });

  const response = await harness.send({
    type: "configureProvider",
    apiKey: "   ",
    provider: "deepseek",
    providerDataConsent: true,
    providerDataConsentVersion: 1,
    targetLanguage: "ru"
  });

  assert.equal(response.model, "deepseek-v4-flash");
  assert.equal(harness.storageData.providerApiKeysV1.deepseek, storedKey);
  assert.equal(harness.storageData.settingsV1.targetLanguage, "ru");
});

test("preserves settings and other provider keys changed during provider verification", async () => {
  const candidateKey = "candidate-deepseek-api-key-for-background";
  const updatedOpenAiKey = "updated-openai-api-key-for-background";
  let harness;
  harness = createHarness({
    async fetchImpl(url) {
      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "deepseek-v4-flash" }] };
          }
        };
      }

      harness.storageData.providerApiKeysV1.openai = updatedOpenAiKey;
      harness.storageData.settingsV1 = {
        ...harness.storageData.settingsV1,
        protectedTerms: ["KeepMe"],
        siteRules: { "https://example.com": "never" }
      };
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: {
        deepseek: "old-deepseek-api-key-for-background",
        openai: "old-openai-api-key-for-background"
      },
      settingsV1: {
        provider: "openai",
        providerModels: {
          deepseek: "deepseek-v4-flash",
          openai: "gpt-5.6-luna"
        },
        targetLanguage: "en",
        version: 2
      }
    }
  });

  await harness.send({
    type: "configureProvider",
    apiKey: candidateKey,
    provider: "deepseek",
    providerDataConsent: true,
    providerDataConsentVersion: 1,
    targetLanguage: "ru"
  });

  assert.equal(harness.storageData.providerApiKeysV1.deepseek, candidateKey);
  assert.equal(harness.storageData.providerApiKeysV1.openai, updatedOpenAiKey);
  assert.deepEqual(Array.from(harness.storageData.settingsV1.protectedTerms), ["KeepMe"]);
  assert.deepEqual(
    { ...harness.storageData.settingsV1.siteRules },
    { "https://example.com": "never" }
  );
  assert.equal(harness.storageData.settingsV1.targetLanguage, "ru");
});

test("does not restore a saved provider key changed during verification", async () => {
  const storedKey = "stored-deepseek-api-key-for-background";
  let harness;
  harness = createHarness({
    async fetchImpl(url) {
      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "deepseek-v4-flash" }] };
          }
        };
      }

      delete harness.storageData.providerApiKeysV1.deepseek;
      return createResponse([]);
    },
    storage: {
      providerApiKeysV1: { deepseek: storedKey },
      settingsV1: {
        provider: "deepseek",
        targetLanguage: "en",
        version: 2
      }
    }
  });

  await assert.rejects(
    harness.send({
      type: "configureProvider",
      apiKey: "",
      provider: "deepseek",
      providerDataConsent: true,
      providerDataConsentVersion: 1,
      targetLanguage: "ru"
    }),
    /configuration changed/u
  );

  assert.equal(harness.storageData.providerApiKeysV1.deepseek, undefined);
  assert.equal(harness.storageData.settingsV1.targetLanguage, "en");
});

test("does not save a candidate provider key before connection verification succeeds", async () => {
  const harness = createHarness({
    async fetchImpl(url) {
      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "deepseek-v4-flash" }] };
          }
        };
      }

      return {
        ok: false,
        status: 401,
        async json() {
          return { error: { message: "Invalid API key" } };
        }
      };
    },
    storage: {
      providerApiKeysV1: {},
      settingsV1: {
        provider: "openai",
        targetLanguage: "en",
        version: 2
      }
    }
  });

  await assert.rejects(
    harness.send({
      type: "configureProvider",
      apiKey: "invalid-candidate-api-key-for-background",
      provider: "deepseek",
      providerDataConsent: true,
      providerDataConsentVersion: 1,
      targetLanguage: "ru"
    }),
    /Invalid API key/u
  );

  assert.equal(harness.storageData.providerApiKeysV1.deepseek, undefined);
  assert.equal(harness.storageData.settingsV1.provider, "openai");
  assert.equal(harness.storageData.settingsV1.targetLanguage, "en");
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
