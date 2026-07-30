(function initializeBackground() {
  const api = globalThis.browser;
  const {
    buildMessages,
    createCacheIdentity,
    estimateCacheEntryBytes,
    maskProtectedTerms,
    MAX_CACHE_BYTES,
    normalizeText,
    parseTranslationJson,
    restoreProtectedTerms,
    sha256Hex,
    shouldRefreshCachedTranslation,
    shouldRetryUnchangedTranslation,
    UNCHANGED_TRANSLATION_RETRY_MS,
    UNCHANGED_TRANSLATION_VERSION
  } = globalThis.SmartTranslationCore;
  const {
    buildProviderRequest,
    filterProviderModels,
    getModelsUrl,
    getSelectedModel,
    normalizeProvider,
    normalizeProviderModels,
    PROVIDERS
  } = globalThis.SmartTranslationProviderCore;

  const SETTINGS_KEY = "settingsV1";
  const PROVIDER_KEYS_KEY = "providerApiKeysV1";
  const LEGACY_DEEPSEEK_KEY = "deepseekApiKeyV1";
  const CACHE_KEY = "translationCacheV1";
  const CACHE_ENTRY_PREFIX = "translationCacheEntryV1:";
  const CACHE_INDEX_KEY = "translationCacheIndexV1";
  const CACHE_INDEX_DIRTY_KEY = "translationCacheIndexDirtyV1";
  const CACHE_INDEX_VERSION = 1;
  const CACHE_INDEX_DIRTY_BYTES = 1 + estimateCacheEntryBytes("", true, CACHE_INDEX_DIRTY_KEY);
  const CONTEXT_MENU_ID = "translate-text";
  const LEGACY_CONTEXT_MENU_IDS = Object.freeze([
    "translate-selection",
    "translate-editable"
  ]);
  const ONBOARDING_VERSION_KEY = "onboardingShownVersion";
  const SETTINGS_VERSION = 4;
  const PROVIDER_DATA_CONSENT_VERSION = 1;
  const DEFAULT_SETTINGS = Object.freeze({
    animationEnabled: true,
    autoTranslateLanguages: [],
    cacheMaxEntries: 16000,
    contextMenuEnabled: true,
    defaultViewMode: "translated",
    provider: "deepseek",
    providerModels: Object.freeze({
      deepseek: PROVIDERS.deepseek.defaultModel,
      openai: PROVIDERS.openai.defaultModel
    }),
    providerDataConsentVersion: 0,
    protectedTerms: [],
    selectionButtonEnabled: false,
    siteRules: {},
    siteViewModes: {},
    sourceLanguage: "auto",
    targetLanguage: "ru",
    version: SETTINGS_VERSION
  });
  const MAX_BATCH_CHARACTERS = 10000;
  const MAX_BATCH_TRANSLATION_CHARACTERS = 40000;
  const MAX_BATCH_ITEMS = 48;
  const MAX_CONTEXT_CHARACTERS = 400;
  const MAX_CUSTOM_PROTECTED_TERMS = 256;
  const FOCUSED_RETRY_BATCH_SIZE = 8;
  const MAX_CACHE_ENTRIES = 20000;
  const MAX_CONCURRENT_REQUESTS = 3;
  const MAX_ID_CHARACTERS = 64;
  const MAX_ITEM_TEXT_CHARACTERS = 8000;
  const MAX_PROVIDER_ATTEMPTS_PER_BATCH = 12;
  const MAX_PROTECTED_TERM_CHARACTERS = 100;
  const MAX_PROTECTED_TERMS = 20;
  const MAX_QUEUED_REQUESTS = 64;
  const MAX_REQUEST_QUEUE_WAIT_MS = 15000;
  const MAX_TRANSLATION_EXPANSION_RATIO = 4;
  const MAX_TRANSLATION_TEXT_CHARACTERS = 16000;
  const MIN_TRANSLATION_TEXT_CHARACTERS = 512;
  const CACHE_INDEX_FLUSH_DELAY_MS = 15000;
  const NETWORK_TOTAL_DEADLINE_MS = 28000;
  const PROVIDER_CIRCUIT_COOLDOWN_MS = 30000;
  const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 3;
  const PRIVILEGED_MESSAGE_TYPES = new Set([
    "clearCache",
    "configureProvider",
    "getCacheStats",
    "listProviderModels",
    "setSiteMode",
    "setSiteViewMode",
    "testProviderConnection",
    "updateProviderKey",
    "updateSettings"
  ]);
  let cachePromise;
  let cacheReleaseTimer;
  let cacheIndexFlushTimer;
  let cacheWritePromise = Promise.resolve();
  let cacheGeneration = 0;
  let cacheEntryCount = 0;
  let cacheEstimatedBytes = 2;
  let activeRequestCount = 0;
  let settingsInitialized = false;
  let settingsInitializationPromise;
  let settingsWritePromise = Promise.resolve();
  const activeTranslationRequests = new Set();
  const cacheStates = new WeakMap();
  const inFlightTranslations = new Map();
  const providerCircuitStates = new Map();
  const providerModelCache = new Map();
  const requestWaiters = [];
  const storageAccessPromise = restrictLocalStorageAccess();

  void storageAccessPromise.catch(() => undefined);

  async function restrictLocalStorageAccess() {
    const isFirefox = api.runtime.getURL("").startsWith("moz-extension:");

    if (typeof api.storage.local.setAccessLevel !== "function") {
      if (isFirefox) {
        return;
      }

      throw new Error("This browser cannot isolate extension storage from content scripts.");
    }

    const accessLevel = "TRUSTED_CONTEXTS";
    const argument = isFirefox ? accessLevel : { accessLevel };
    await api.storage.local.setAccessLevel(argument);
  }

  function createCancellationError() {
    const error = new Error("Translation request cancelled.");
    error.cancelled = true;
    return error;
  }

  function throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw createCancellationError();
    }
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      throwIfCancelled(signal);
      const handleAbort = () => {
        clearTimeout(timer);
        reject(createCancellationError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  async function withRequestSlot(task, signal) {
    throwIfCancelled(signal);

    if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
      if (requestWaiters.length >= MAX_QUEUED_REQUESTS) {
        throw new Error("Translation request queue is full. Retry shortly.");
      }

      await new Promise((resolve, reject) => {
        const removeWaiter = () => {
          const index = requestWaiters.indexOf(waiter);

          if (index >= 0) {
            requestWaiters.splice(index, 1);
          }
        };
        const handleAbort = () => {
          removeWaiter();
          waiter.reject(createCancellationError());
        };
        const waiter = {
          reject(error) {
            clearTimeout(waiter.timer);
            signal?.removeEventListener("abort", handleAbort);
            reject(error);
          },
          resolve() {
            clearTimeout(waiter.timer);
            signal?.removeEventListener("abort", handleAbort);
            resolve();
          },
          timer: setTimeout(() => {
            removeWaiter();
            waiter.reject(new Error("Translation request queue timed out. Retry shortly."));
          }, MAX_REQUEST_QUEUE_WAIT_MS)
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
        requestWaiters.push(waiter);
      });
    } else {
      activeRequestCount += 1;
    }

    try {
      throwIfCancelled(signal);
      return await task();
    } finally {
      const nextWaiter = requestWaiters.shift();

      if (nextWaiter) {
        nextWaiter.resolve();
      } else {
        activeRequestCount -= 1;
      }
    }
  }

  function normalizeSite(value) {
    try {
      const candidate = String(value ?? "").trim();
      const url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(candidate) ? candidate : `https://${candidate}`);
      return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  }

  function normalizeLanguage(value, fallback) {
    const language = String(value ?? "").trim();
    return language === "auto" || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)
      ? language
      : fallback;
  }

  function normalizeLanguageList(value) {
    const languages = Array.isArray(value) ? value : [];
    return [...new Set(languages
      .map((language) => normalizeLanguage(language, ""))
      .filter((language) => language && language !== "auto"))].slice(0, 30);
  }

  function normalizeViewMode(value, fallback = DEFAULT_SETTINGS.defaultViewMode) {
    return ["bilingual", "translated"].includes(value) ? value : fallback;
  }

  function normalizeProtectedTerms(value) {
    const terms = Array.isArray(value) ? value : [];
    const normalized = new Map();

    for (const value of terms) {
      const term = normalizeText(value);
      const key = term.toLowerCase();

      if (term.length < 2
        || term.length > MAX_PROTECTED_TERM_CHARACTERS
        || normalized.has(key)) {
        continue;
      }

      normalized.set(key, term);

      if (normalized.size >= MAX_CUSTOM_PROTECTED_TERMS) {
        break;
      }
    }

    return [...normalized.values()];
  }

  function normalizeSiteRules(value, legacyEnabledSites) {
    const siteRules = {};

    if (value && typeof value === "object") {
      for (const [site, mode] of Object.entries(value)) {
        const normalizedSite = normalizeSite(site);

        if (normalizedSite && ["always", "never"].includes(mode)) {
          siteRules[normalizedSite] = mode;
        }
      }
    }

    if (legacyEnabledSites && typeof legacyEnabledSites === "object") {
      for (const [site, enabled] of Object.entries(legacyEnabledSites)) {
        const normalizedSite = normalizeSite(site);

        if (normalizedSite && enabled === true && !siteRules[normalizedSite]) {
          siteRules[normalizedSite] = "always";
        }
      }
    }

    return siteRules;
  }

  function normalizeSiteViewModes(value) {
    const siteViewModes = {};

    if (value && typeof value === "object") {
      for (const [site, viewMode] of Object.entries(value)) {
        const normalizedSite = normalizeSite(site);

        if (normalizedSite && ["bilingual", "translated"].includes(viewMode)) {
          siteViewModes[normalizedSite] = viewMode;
        }
      }
    }

    return siteViewModes;
  }

  function sanitizeSettings(value) {
    const provider = normalizeProvider(value?.provider);
    const providerModels = normalizeProviderModels(value?.providerModels, value?.model);

    return {
      animationEnabled: value?.animationEnabled !== false,
      autoTranslateLanguages: normalizeLanguageList(value?.autoTranslateLanguages),
      cacheMaxEntries: Math.min(
        MAX_CACHE_ENTRIES,
        Math.max(100, Math.round(Number(value?.cacheMaxEntries) || DEFAULT_SETTINGS.cacheMaxEntries))
      ),
      contextMenuEnabled: value?.contextMenuEnabled !== false,
      defaultViewMode: normalizeViewMode(value?.defaultViewMode),
      provider,
      providerModels,
      providerDataConsentVersion: value?.providerDataConsentVersion === PROVIDER_DATA_CONSENT_VERSION
        ? PROVIDER_DATA_CONSENT_VERSION
        : 0,
      protectedTerms: normalizeProtectedTerms(value?.protectedTerms),
      selectionButtonEnabled: value?.selectionButtonEnabled === true,
      siteRules: normalizeSiteRules(value?.siteRules, value?.enabledSites),
      siteViewModes: normalizeSiteViewModes(value?.siteViewModes),
      sourceLanguage: normalizeLanguage(value?.sourceLanguage, DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: normalizeLanguage(value?.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
      version: SETTINGS_VERSION
    };
  }

  async function readSettings(migrate = false) {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    const current = stored[SETTINGS_KEY];
    const currentVersion = Number(current?.version || 0);
    let hasExistingProviderKey = false;

    if (!current || currentVersion < SETTINGS_VERSION) {
      const providerStorage = await api.storage.local.get([
        PROVIDER_KEYS_KEY,
        LEGACY_DEEPSEEK_KEY
      ]);
      const storedProviderKeys = providerStorage[PROVIDER_KEYS_KEY];
      hasExistingProviderKey = Boolean(
        providerStorage[LEGACY_DEEPSEEK_KEY]
        || storedProviderKeys && Object.values(storedProviderKeys).some(Boolean)
      );
    }
    const migrated = current && currentVersion < SETTINGS_VERSION
      ? {
        ...current,
        cacheMaxEntries: currentVersion < 2 && Number(current.cacheMaxEntries) === 8000
          ? DEFAULT_SETTINGS.cacheMaxEntries
          : current.cacheMaxEntries,
        providerDataConsentVersion: hasExistingProviderKey
          ? PROVIDER_DATA_CONSENT_VERSION
          : current.providerDataConsentVersion,
        version: SETTINGS_VERSION
      }
      : current;
    const settings = sanitizeSettings(migrated ?? {
      ...DEFAULT_SETTINGS,
      providerDataConsentVersion: hasExistingProviderKey ? PROVIDER_DATA_CONSENT_VERSION : 0
    });

    if (migrate && current && currentVersion < SETTINGS_VERSION) {
      await api.storage.local.set({ [SETTINGS_KEY]: settings });
    }

    return settings;
  }

  function queueSettingsWrite(operation) {
    const result = settingsWritePromise
      .catch(() => undefined)
      .then(operation);
    settingsWritePromise = result.then(() => undefined, () => undefined);
    return result;
  }

  function initializeSettings() {
    if (!settingsInitializationPromise) {
      const initialization = queueSettingsWrite(() => readSettings(true))
        .then((settings) => {
          settingsInitialized = true;
          return settings;
        })
        .catch((error) => {
          if (settingsInitializationPromise === initialization) {
            settingsInitializationPromise = undefined;
          }

          throw error;
        });
      settingsInitializationPromise = initialization;
    }

    return settingsInitializationPromise;
  }

  function getSettings() {
    return settingsInitialized ? readSettings() : initializeSettings();
  }

  function runSettingsWrite(operation) {
    return initializeSettings().then(() => queueSettingsWrite(operation));
  }

  async function writeSettings(settings) {
    const sanitized = sanitizeSettings(settings);
    await api.storage.local.set({ [SETTINGS_KEY]: sanitized });
    return sanitized;
  }

  async function saveSettings(settings) {
    const sanitized = await runSettingsWrite(() => writeSettings(settings));
    await broadcastSettings();
    return sanitized;
  }

  async function mutateSettings(mutator) {
    const sanitized = await runSettingsWrite(async () => {
      const settings = await getSettings();
      const nextSettings = await mutator(settings);
      return writeSettings(nextSettings ?? settings);
    });
    await broadcastSettings();
    return sanitized;
  }

  async function broadcastSettings() {
    const tabs = await api.tabs.query({});
    await Promise.allSettled(tabs
      .filter(({ id }) => id != null)
      .map(({ id }) => api.tabs.sendMessage(id, {
        type: "settingsChanged"
      })));
  }

  async function getProviderKeys() {
    const stored = await api.storage.local.get([PROVIDER_KEYS_KEY, LEGACY_DEEPSEEK_KEY]);
    const keys = stored[PROVIDER_KEYS_KEY] && typeof stored[PROVIDER_KEYS_KEY] === "object"
      ? stored[PROVIDER_KEYS_KEY]
      : {};
    const deepseek = String(keys.deepseek || stored[LEGACY_DEEPSEEK_KEY] || "").trim();
    const openai = String(keys.openai || "").trim();
    return { deepseek, openai };
  }

  async function getProviderKey(providerValue) {
    const provider = normalizeProvider(providerValue);
    return (await getProviderKeys())[provider];
  }

  function assertProviderDataConsent(consent, version) {
    if (consent !== true || version !== PROVIDER_DATA_CONSENT_VERSION) {
      throw new Error("Confirm the current provider data disclosure before contacting a translation provider.");
    }
  }

  function assertStoredProviderDataConsent(settings) {
    if (settings.providerDataConsentVersion !== PROVIDER_DATA_CONSENT_VERSION) {
      throw new Error("Provider data consent is required. Open the extension settings.");
    }
  }

  function scheduleCacheRelease() {
    clearTimeout(cacheReleaseTimer);
    cacheReleaseTimer = setTimeout(() => {
      if (activeRequestCount > 0) {
        scheduleCacheRelease();
        return;
      }

      cachePromise = undefined;
    }, 120000);
  }

  function getCacheEntryStorageKey(cacheKey) {
    return `${CACHE_ENTRY_PREFIX}${cacheKey}`;
  }

  function isCacheKey(value) {
    return /^[a-z0-9_-]{1,128}$/iu.test(value);
  }

  async function removeStorageKeys(keys) {
    for (let index = 0; index < keys.length; index += 500) {
      await api.storage.local.remove(keys.slice(index, index + 500));
    }
  }

  async function getCache() {
    if (!cachePromise) {
      const generation = cacheGeneration;
      const pendingCache = api.storage.local.get([
        CACHE_INDEX_KEY,
        CACHE_INDEX_DIRTY_KEY,
        CACHE_KEY
      ]).then(async (indexedStorage) => {
        const storedIndex = indexedStorage[CACHE_INDEX_DIRTY_KEY]
          ? null
          : normalizeCacheIndex(indexedStorage[CACHE_INDEX_KEY]);
        const cache = {};

        if (storedIndex) {
          initializeCacheState(cache, storedIndex, generation);

          if (Object.hasOwn(indexedStorage, CACHE_KEY)) {
            cacheWritePromise = cacheWritePromise
              .catch(() => undefined)
              .then(async () => {
                if (generation === cacheGeneration) {
                  await removeStorageKeys([CACHE_KEY]);
                }
              });
            await cacheWritePromise;
          }

          return cache;
        }

        const stored = await api.storage.local.get(null);
        const legacyCache = stored[CACHE_KEY];
        const hasLegacyCache = Boolean(
          legacyCache && typeof legacyCache === "object" && !Array.isArray(legacyCache)
        );
        const normalizedCache = hasLegacyCache
          ? Object.fromEntries(Object.entries(legacyCache).filter(([key]) => isCacheKey(key)))
          : {};

        for (const [key, entry] of Object.entries(stored)) {
          const cacheKey = key.startsWith(CACHE_ENTRY_PREFIX)
            ? key.slice(CACHE_ENTRY_PREFIX.length)
            : "";

          if (isCacheKey(cacheKey)) {
            normalizedCache[cacheKey] = entry;
          }
        }

        const index = createCacheIndex(normalizedCache);
        Object.assign(cache, normalizedCache);
        initializeCacheState(cache, index, generation);
        const migratedEntries = hasLegacyCache
          ? Object.fromEntries(Object.entries(normalizedCache).map(([key, entry]) => [
            getCacheEntryStorageKey(key),
            entry
          ]))
          : {};
        cacheWritePromise = cacheWritePromise
          .catch(() => undefined)
          .then(async () => {
            if (generation !== cacheGeneration) {
              return;
            }

            await api.storage.local.set({
              ...migratedEntries,
              [CACHE_INDEX_KEY]: serializeCacheIndex(index)
            });

            if (generation === cacheGeneration && Object.hasOwn(stored, CACHE_KEY)) {
              await removeStorageKeys([CACHE_KEY]);
            }

            if (generation === cacheGeneration) {
              await removeStorageKeys([CACHE_INDEX_DIRTY_KEY]);
            }
          });
        await cacheWritePromise;
        return cache;
      }).catch((error) => {
        if (cachePromise === pendingCache) {
          cachePromise = undefined;
        }

        throw error;
      });
      cachePromise = pendingCache;
    }

    scheduleCacheRelease();

    return cachePromise;
  }

  function createCacheIndex(cache) {
    return {
      entries: Object.fromEntries(Object.entries(cache).map(([key, entry]) => [
        key,
        {
          bytes: estimateCacheEntryBytes(key, entry, CACHE_ENTRY_PREFIX),
          lastUsed: Number(entry?.lastUsed || 0)
        }
      ]))
    };
  }

  function normalizeCacheIndex(value) {
    if (value?.version !== CACHE_INDEX_VERSION
      || !value.entries
      || typeof value.entries !== "object"
      || Array.isArray(value.entries)) {
      return null;
    }

    const entries = {};

    for (const [key, metadata] of Object.entries(value.entries)) {
      if (!isCacheKey(key)
        || !Number.isSafeInteger(metadata?.bytes)
        || metadata.bytes <= 0
        || !Number.isFinite(Number(metadata.lastUsed))) {
        return null;
      }

      entries[key] = {
        bytes: metadata.bytes,
        lastUsed: Number(metadata.lastUsed)
      };
    }

    return { entries };
  }

  function serializeCacheIndex(index) {
    return {
      entries: Object.fromEntries(Object.entries(index.entries).map(([key, metadata]) => [
        key,
        { ...metadata }
      ])),
      version: CACHE_INDEX_VERSION
    };
  }

  function getIndexedCacheBytes(index) {
    const metadata = Object.values(index.entries);
    return 2
      + metadata.length
      + metadata.reduce((total, entry) => total + entry.bytes, 0)
      + getCacheIndexStorageBytes(index);
  }

  function getCacheIndexStorageBytes(index) {
    return estimateCacheEntryBytes("", serializeCacheIndex(index), CACHE_INDEX_KEY);
  }

  function updateCacheIndexMetadata(state, key, metadata) {
    const previous = state.index.entries[key];
    const previousBytes = previous ? estimateCacheEntryBytes(key, previous) : 0;
    const separatorBytes = !previous && cacheEntryCount > 0 ? 1 : 0;
    const nextBytes = estimateCacheEntryBytes(key, metadata);
    state.index.entries[key] = metadata;
    return nextBytes - previousBytes + separatorBytes;
  }

  function removeCacheIndexMetadata(state, key) {
    const metadata = state.index.entries[key];

    if (!metadata) {
      return 0;
    }

    const separatorBytes = cacheEntryCount > 1 ? 1 : 0;
    const difference = -estimateCacheEntryBytes(key, metadata) - separatorBytes;
    delete state.index.entries[key];
    return difference;
  }

  function initializeCacheState(cache, index, generation) {
    cacheStates.set(cache, {
      dirtyKeys: new Set(),
      dirtyMarkerPersisted: false,
      generation,
      index,
      indexDirty: false,
      persistedIndexBytes: getCacheIndexStorageBytes(index),
      removedKeys: new Set()
    });

    if (generation === cacheGeneration) {
      cacheEntryCount = Object.keys(index.entries).length;
      cacheEstimatedBytes = getIndexedCacheBytes(index);
    }
  }

  async function loadCacheEntries(cache, keys) {
    const state = cacheStates.get(cache);

    if (state?.generation !== cacheGeneration) {
      return;
    }

    const cacheKeys = [...new Set(keys)].filter((key) => (
      Object.hasOwn(state.index.entries, key) && !Object.hasOwn(cache, key)
    ));

    if (cacheKeys.length === 0) {
      return;
    }

    const storageKeys = cacheKeys.map(getCacheEntryStorageKey);
    const stored = await api.storage.local.get(storageKeys);

    if (state.generation !== cacheGeneration) {
      return;
    }

    for (const key of cacheKeys) {
      const metadata = state.index.entries[key];

      if (!metadata || Object.hasOwn(cache, key)) {
        continue;
      }

      const storageKey = getCacheEntryStorageKey(key);

      if (!Object.hasOwn(stored, storageKey)) {
        removeIndexedCacheEntry(cache, key, false);
        continue;
      }

      const entry = stored[storageKey];
      const bytes = estimateCacheEntryBytes(key, entry, CACHE_ENTRY_PREFIX);
      cache[key] = entry;

      if (metadata.bytes !== bytes || metadata.lastUsed !== Number(entry?.lastUsed || 0)) {
        const indexDifference = updateCacheIndexMetadata(state, key, {
          bytes,
          lastUsed: Number(entry?.lastUsed || 0)
        });
        cacheEstimatedBytes += bytes - metadata.bytes + indexDifference;
        state.indexDirty = true;
      }
    }
  }

  function pruneCache(cache, maximumEntries) {
    const state = cacheStates.get(cache);

    if (state?.generation !== cacheGeneration) {
      return 0;
    }

    if (isCacheWithinLimits(state, maximumEntries)) {
      return 0;
    }

    const entries = Object.entries(state.index.entries)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    let removedEntries = 0;

    for (const [key] of entries) {
      if (isCacheWithinLimits(state, maximumEntries)) {
        break;
      }

      removeIndexedCacheEntry(cache, key);
      removedEntries += 1;
    }

    return removedEntries;
  }

  function isCacheWithinLimits(state, maximumEntries) {
    return cacheEntryCount <= maximumEntries
      && getPhysicalCacheBytes(state) <= MAX_CACHE_BYTES;
  }

  function getPhysicalCacheBytes(state) {
    const currentIndexBytes = getCacheIndexStorageBytes(state.index);
    const indexBytes = Math.max(currentIndexBytes, state.persistedIndexBytes);
    const pendingMarkerBytes = state.indexDirty ? CACHE_INDEX_DIRTY_BYTES : 0;
    return cacheEstimatedBytes - currentIndexBytes + indexBytes + pendingMarkerBytes;
  }

  function removeIndexedCacheEntry(cache, key, removeStorage = true) {
    const state = cacheStates.get(cache);
    const metadata = state?.index.entries[key];

    if (state?.generation !== cacheGeneration || !metadata) {
      return;
    }

    delete cache[key];
    const indexDifference = removeCacheIndexMetadata(state, key);
    state.dirtyKeys.delete(key);
    state.indexDirty = true;

    if (removeStorage) {
      state.removedKeys.add(key);
    }

    cacheEntryCount -= 1;
    cacheEstimatedBytes = Math.max(
      getIndexedCacheBytes({ entries: {} }),
      cacheEstimatedBytes - metadata.bytes - 1 + indexDifference
    );
  }

  function markCacheEntryDirty(cache, key) {
    const state = cacheStates.get(cache);

    if (state?.generation !== cacheGeneration) {
      return;
    }

    state.removedKeys.delete(key);
    const entry = cache[key];
    const previous = state.index.entries[key];
    const bytes = estimateCacheEntryBytes(key, entry, CACHE_ENTRY_PREFIX);
    const indexDifference = updateCacheIndexMetadata(state, key, {
      bytes,
      lastUsed: Number(entry?.lastUsed || 0)
    });

    if (previous) {
      cacheEstimatedBytes += bytes - previous.bytes + indexDifference;
    } else {
      cacheEstimatedBytes += bytes + 1 + indexDifference;
      cacheEntryCount += 1;
    }
    state.indexDirty = true;
    state.dirtyKeys.add(key);
  }

  function hasPendingCacheChanges(cache) {
    const state = cacheStates.get(cache);
    return state?.generation === cacheGeneration
      && (state.indexDirty || state.dirtyKeys.size > 0 || state.removedKeys.size > 0);
  }

  function scheduleCacheIndexFlush(cache) {
    clearTimeout(cacheIndexFlushTimer);
    cacheIndexFlushTimer = setTimeout(() => {
      cacheIndexFlushTimer = undefined;
      void flushCacheIndex(cache).catch(() => undefined);
    }, CACHE_INDEX_FLUSH_DELAY_MS);
  }

  function flushCacheIndex(cache) {
    const state = cacheStates.get(cache);
    const generation = state?.generation;

    if (generation !== cacheGeneration || !state.indexDirty) {
      return cacheWritePromise;
    }

    cacheWritePromise = cacheWritePromise
      .catch(() => undefined)
      .then(async () => {
        if (generation !== cacheGeneration || !state.indexDirty) {
          return;
        }

        if (state.dirtyKeys.size > 0 || state.removedKeys.size > 0) {
          scheduleCacheIndexFlush(cache);
          return;
        }

        const storedIndex = serializeCacheIndex(state.index);
        const storedIndexBytes = getCacheIndexStorageBytes(state.index);
        await api.storage.local.set({ [CACHE_INDEX_KEY]: storedIndex });

        if (generation !== cacheGeneration) {
          return;
        }

        state.persistedIndexBytes = storedIndexBytes;

        if (state.dirtyKeys.size > 0 || state.removedKeys.size > 0) {
          scheduleCacheIndexFlush(cache);
          return;
        }

        if (state.dirtyMarkerPersisted) {
          await removeStorageKeys([CACHE_INDEX_DIRTY_KEY]);
          state.dirtyMarkerPersisted = false;
        }

        if (state.dirtyKeys.size > 0 || state.removedKeys.size > 0) {
          state.indexDirty = true;
          scheduleCacheIndexFlush(cache);
          return;
        }

        state.indexDirty = false;
      });
    return cacheWritePromise;
  }

  function saveCache(cache, maximumEntries) {
    const state = cacheStates.get(cache);
    const generation = state?.generation;

    if (generation !== cacheGeneration) {
      return cacheWritePromise;
    }

    cacheWritePromise = cacheWritePromise
      .catch(() => undefined)
      .then(async () => {
        if (generation !== cacheGeneration) {
          return;
        }

        pruneCache(cache, maximumEntries);
        const dirtyKeys = [...state.dirtyKeys];
        const removedCacheKeys = [...state.removedKeys];
        const dirtyEntries = Object.fromEntries(dirtyKeys
          .filter((key) => Object.hasOwn(cache, key))
          .map((key) => [getCacheEntryStorageKey(key), cache[key]]));
        const removedKeys = removedCacheKeys.map(getCacheEntryStorageKey);
        state.dirtyKeys.clear();
        state.removedKeys.clear();

        try {
          if (dirtyKeys.length === 0 && removedCacheKeys.length === 0) {
            scheduleCacheIndexFlush(cache);
            return;
          }

          if (!state.dirtyMarkerPersisted) {
            await api.storage.local.set({ [CACHE_INDEX_DIRTY_KEY]: true });

            if (generation === cacheGeneration) {
              state.dirtyMarkerPersisted = true;
            }
          }

          if (removedKeys.length > 0) {
            await removeStorageKeys(removedKeys);
          }

          if (generation === cacheGeneration && Object.keys(dirtyEntries).length > 0) {
            await api.storage.local.set(dirtyEntries);
          }

          scheduleCacheIndexFlush(cache);
        } catch (error) {
          if (generation === cacheGeneration) {
            state.indexDirty = true;

            for (const key of dirtyKeys) {
              if (Object.hasOwn(cache, key)) {
                state.dirtyKeys.add(key);
              }
            }

            for (const key of removedCacheKeys) {
              if (!Object.hasOwn(cache, key)) {
                state.removedKeys.add(key);
              }
            }
          }

          throw error;
        }
      });
    scheduleCacheRelease();
    return cacheWritePromise;
  }

  async function readApiError(response, providerLabel = "Translation provider") {
    try {
      const body = await response.json();
      return String(body?.error?.message || body?.message || `HTTP ${response.status}`).slice(0, 300);
    } catch {
      return `${providerLabel} returned HTTP ${response.status}.`;
    }
  }

  function getRetryAfterMilliseconds(response) {
    const value = response?.headers?.get?.("retry-after");

    if (!value) {
      return undefined;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
  }

  function getRetryDelayMilliseconds(attempt, retryAfterMilliseconds) {
    const baseDelay = retryAfterMilliseconds ?? 700 * (attempt + 1);
    const maximumJitter = Math.min(250, Math.max(25, baseDelay * 0.1));
    const jitter = 1 + Math.floor(Math.random() * maximumJitter);
    return baseDelay + jitter;
  }

  function assertProviderCircuitClosed(providerOrigin) {
    const state = providerCircuitStates.get(providerOrigin);

    if (!state) {
      return;
    }

    if (!state.openedUntil) {
      return;
    }

    if (state.openedUntil <= Date.now()) {
      providerCircuitStates.delete(providerOrigin);
      return;
    }

    const error = new Error("The translation provider is temporarily unavailable after repeated failures. Retry shortly.");
    error.retryable = false;
    error.providerCircuitOpen = true;
    throw error;
  }

  function recordProviderCircuitFailure(providerOrigin) {
    const current = providerCircuitStates.get(providerOrigin);
    const failures = Number(current?.failures || 0) + 1;
    providerCircuitStates.set(providerOrigin, {
      failures,
      openedUntil: failures >= PROVIDER_CIRCUIT_FAILURE_THRESHOLD
        ? Date.now() + PROVIDER_CIRCUIT_COOLDOWN_MS
        : 0
    });
  }

  function resetProviderCircuit(providerOrigin) {
    providerCircuitStates.delete(providerOrigin);
  }

  async function fetchJsonWithRetry(
    url,
    options,
    providerLabel = "Translation provider",
    beforeAttempt,
    signal,
    deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS
  ) {
    let lastError;
    const providerOrigin = new URL(url).origin;
    assertProviderCircuitClosed(providerOrigin);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfCancelled(signal);
      assertProviderCircuitClosed(providerOrigin);
      const remainingMilliseconds = deadline - Date.now();

      if (remainingMilliseconds <= 0) {
        if (lastError) {
          recordProviderCircuitFailure(providerOrigin);
        }

        throw lastError || new Error(`${providerLabel} request deadline expired.`);
      }

      const controller = new AbortController();
      let timedOut = false;
      let retryAfterMilliseconds;
      const handleAbort = () => controller.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remainingMilliseconds);
      signal?.addEventListener("abort", handleAbort, { once: true });

      try {
        await beforeAttempt?.();
        throwIfCancelled(signal);
        const response = await fetch(url, { ...options, signal: controller.signal });

        if (response.ok) {
          resetProviderCircuit(providerOrigin);
          return await response.json();
        }

        if (response.status !== 429 && response.status < 500) {
          resetProviderCircuit(providerOrigin);
          const error = new Error(await readApiError(response, providerLabel));
          error.retryable = false;
          throw error;
        }

        retryAfterMilliseconds = getRetryAfterMilliseconds(response);
        lastError = new Error(`${providerLabel} temporarily returned HTTP ${response.status}.`);
        lastError.retryable = true;
      } catch (error) {
        throwIfCancelled(signal);
        lastError = error?.name === "AbortError" && timedOut
          ? new Error(`${providerLabel} request timed out.`)
          : error;
        lastError.retryable = lastError?.retryable !== false
          && /temporarily|timed out|network|fetch|429|5\d\d/iu.test(String(lastError?.message));

        if (attempt === 2
          || lastError?.retryable === false
          || !lastError?.retryable) {
          if (lastError?.retryable) {
            recordProviderCircuitFailure(providerOrigin);
          }

          throw lastError;
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
      }

      if (attempt === 2) {
        recordProviderCircuitFailure(providerOrigin);
        throw lastError;
      }

      const retryDelay = getRetryDelayMilliseconds(attempt, retryAfterMilliseconds);

      if (Date.now() + retryDelay >= deadline) {
        recordProviderCircuitFailure(providerOrigin);
        throw lastError || new Error(`${providerLabel} retry deadline expired.`);
      }

      await delay(retryDelay, signal);
    }

    throw lastError || new Error(`${providerLabel} request failed.`);
  }

  async function requestTranslations(
    items,
    settings,
    apiKey,
    attemptBudget,
    notifyTranslationPending,
    signal,
    deadline
  ) {
    const protectedItems = items.map((item) => {
      const protection = maskProtectedTerms(item.text, item.protectedTerms);
      return {
        ...item,
        protection,
        protectedTerms: protection.replacements.map(({ marker }) => marker),
        text: protection.text
      };
    });
    const providerInputCharacters = protectedItems.reduce(
      (sum, item) => sum + item.text.length + item.context.length,
      0
    );

    if (providerInputCharacters > MAX_BATCH_CHARACTERS) {
      const error = new Error("Translation input exceeds the safe provider limit after protecting brand names.");
      error.canSplitBatch = true;
      throw error;
    }

    const totalCharacters = protectedItems.reduce((sum, item) => sum + item.text.length, 0);
    const provider = normalizeProvider(settings.provider);
    const providerDefinition = PROVIDERS[provider];
    const request = buildProviderRequest(provider, {
      maxTokens: Math.min(8192, Math.max(2048, Math.ceil(totalCharacters * 1.1) + items.length * 24)),
      messages: buildMessages(protectedItems, settings.targetLanguage, settings.sourceLanguage),
      model: getSelectedModel(settings)
    });
    await notifyTranslationPending?.();
    const body = await fetchJsonWithRetry(request.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.body)
    }, providerDefinition.label, async () => {
      if (attemptBudget.remaining <= 0) {
        throw new Error(`${providerDefinition.label} could not complete this translation reliably. Scan the page again.`);
      }

      attemptBudget.remaining -= 1;
    }, signal, deadline);
    const content = body?.choices?.[0]?.message?.content;
    const finishReason = body?.choices?.[0]?.finish_reason;

    if (finishReason === "content_filter") {
      const error = new Error(`${providerDefinition.label} blocked this translation with its content filter.`);
      error.retryable = false;
      throw error;
    }

    if (finishReason === "length") {
      const error = new Error(`${providerDefinition.label} response reached its output limit.`);
      error.canSplitBatch = true;
      throw error;
    }

    if (finishReason !== "stop") {
      const error = new Error(
        `${providerDefinition.label} returned a transient finish reason: ${String(finishReason || "missing")}.`
      );
      error.canRetryFinishReason = true;
      throw error;
    }

    if (typeof content !== "string" || !content.trim()) {
      const error = new Error(`${providerDefinition.label} returned an empty translation response.`);
      error.canRetryEmptyResponse = true;
      throw error;
    }

    const parsedTranslations = parseTranslationJson(content, items.map(({ id }) => id));
    const translations = new Map();
    let translationCharacters = 0;

    for (let index = 0; index < protectedItems.length; index += 1) {
      const item = protectedItems[index];
      const sourceItem = items[index];
      const translation = restoreProtectedTerms(
        parsedTranslations.get(item.id),
        item.protection.replacements
      );
      const maximumCharacters = Math.min(
        MAX_TRANSLATION_TEXT_CHARACTERS,
        Math.max(MIN_TRANSLATION_TEXT_CHARACTERS, sourceItem.text.length * MAX_TRANSLATION_EXPANSION_RATIO)
      );
      translationCharacters += translation.length;

      if (translation.length > maximumCharacters
        || translationCharacters > MAX_BATCH_TRANSLATION_CHARACTERS) {
        throw new Error(`${providerDefinition.label} returned an invalid translation response.`);
      }

      translations.set(item.id, translation);
    }

    return {
      translations,
      usage: body?.usage ?? null
    };
  }

  async function requestTranslationsResilient(
    items,
    settings,
    apiKey,
    attemptBudget,
    notifyTranslationPending,
    signal,
    deadline,
    transientResponseRetries = 1
  ) {
    try {
      return await withRequestSlot(() => requestTranslations(
        items,
        settings,
        apiKey,
        attemptBudget,
        notifyTranslationPending,
        signal,
        deadline
      ), signal);
    } catch (error) {
      if ((error?.canRetryEmptyResponse || error?.canRetryFinishReason)
        && transientResponseRetries > 0) {
        return requestTranslationsResilient(
          items,
          settings,
          apiKey,
          attemptBudget,
          notifyTranslationPending,
          signal,
          deadline,
          transientResponseRetries - 1
        );
      }

      if (items.length <= 1 || !error?.canSplitBatch) {
        throw error;
      }

      const midpoint = Math.ceil(items.length / 2);
      const [left, right] = await Promise.all([
        requestTranslationsResilient(
          items.slice(0, midpoint),
          settings,
          apiKey,
          attemptBudget,
          notifyTranslationPending,
          signal,
          deadline
        ),
        requestTranslationsResilient(
          items.slice(midpoint),
          settings,
          apiKey,
          attemptBudget,
          notifyTranslationPending,
          signal,
          deadline
        )
      ]);

      return {
        translations: new Map([...left.translations, ...right.translations]),
        usage: { splitBatches: true }
      };
    }
  }

  async function needsFocusedRetry(text, targetLanguage) {
    try {
      const result = await api.i18n.detectLanguage(text);
      const detected = String(result?.languages?.[0]?.language || "").toLowerCase().split("-")[0];
      const target = String(targetLanguage || "").toLowerCase().split("-")[0];
      const percentage = Number(result?.languages?.[0]?.percentage || 0);
      const reliable = Boolean(result?.isReliable || percentage >= 50);
      return !reliable || !detected || !target || detected !== target;
    } catch {
      return true;
    }
  }

  async function retryFocusedUnchangedTranslations(
    response,
    items,
    settings,
    apiKey,
    attemptBudget,
    notifyTranslationPending,
    signal,
    deadline
  ) {
    throwIfCancelled(signal);
    const candidates = items.filter((item) => shouldRetryUnchangedTranslation(
      response.translations.get(item.id),
      item
    ));
    const decisions = await Promise.all(candidates.map(async (item) => ({
      item,
      retry: await needsFocusedRetry(item.text, settings.targetLanguage)
    })));
    const verifiedUnchangedIds = new Set(decisions
      .filter(({ retry }) => !retry)
      .map(({ item }) => item.id));
    const retryItems = decisions.filter(({ retry }) => retry).map(({ item }) => item);
    const batches = [];

    for (let index = 0; index < retryItems.length; index += FOCUSED_RETRY_BATCH_SIZE) {
      batches.push(retryItems.slice(index, index + FOCUSED_RETRY_BATCH_SIZE));
    }

    const retries = await Promise.allSettled(batches.map((batch) => requestTranslationsResilient(batch, {
      ...settings,
      sourceLanguage: "auto"
    }, apiKey, attemptBudget, notifyTranslationPending, signal, deadline)));
    throwIfCancelled(signal);

    batches.forEach((batch, index) => {
      const retry = retries[index];

      if (retry.status !== "fulfilled") {
        return;
      }

      for (const item of batch) {
        const translation = retry.value.translations.get(item.id);
        response.translations.set(item.id, translation);
      }
    });

    response.focusedRetryItems = retryItems.length;
    response.verifiedUnchangedIds = verifiedUnchangedIds;
    return response;
  }

  function validateItems(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_ITEMS) {
      throw new Error(`A translation batch must contain between 1 and ${MAX_BATCH_ITEMS} items.`);
    }

    const ids = new Set();
    const items = [];
    let totalCharacters = 0;

    for (const item of value) {
      const id = typeof item?.id === "string" || typeof item?.id === "number"
        ? String(item.id)
        : "";
      const rawText = typeof item?.text === "string" ? item.text : "";
      const rawContext = typeof item?.context === "string" ? item.context : "";
      const rawProtectedTerms = Array.isArray(item?.protectedTerms) ? item.protectedTerms : [];

      if (!id
        || id.length > MAX_ID_CHARACTERS
        || ids.has(id)
        || !rawText
        || rawText.length > MAX_ITEM_TEXT_CHARACTERS
        || rawContext.length > MAX_CONTEXT_CHARACTERS
        || rawProtectedTerms.length > MAX_PROTECTED_TERMS
        || rawProtectedTerms.some((term) => (
          typeof term !== "string" || term.length > MAX_PROTECTED_TERM_CHARACTERS
        ))) {
        throw new Error("The translation batch contains an invalid item.");
      }

      const text = normalizeText(rawText);
      const context = normalizeText(rawContext);
      const kind = [
        "brand-name",
        "document",
        "editable",
        "heading",
        "interface",
        "product-title",
        "proper-name",
        "text"
      ].includes(item?.kind)
        ? item.kind
        : "text";

      totalCharacters += text.length + context.length;

      if (!text || totalCharacters > MAX_BATCH_CHARACTERS) {
        throw new Error("The translation batch contains an invalid item.");
      }

      ids.add(id);
      const foldedText = text.toLowerCase();
      const protectedTerms = [...new Map(rawProtectedTerms
        .map((term) => normalizeText(term))
        .filter((term) => term && foldedText.includes(term.toLowerCase()))
        .map((term) => [term.toLowerCase(), term])).values()];
      items.push({ id, text, context, kind, protectedTerms });
    }

    return items;
  }

  async function requestMissingTranslations(
    items,
    settings,
    cache,
    now,
    generation,
    notifyTranslationPending,
    signal,
    persistCache,
    deadline
  ) {
    throwIfCancelled(signal);
    const provider = normalizeProvider(settings.provider);
    const apiKey = await getProviderKey(provider);

    if (!apiKey) {
      throw new Error(`No ${PROVIDERS[provider].label} API key is configured. Open the extension settings.`);
    }

    assertStoredProviderDataConsent(settings);
    const attemptBudget = { remaining: MAX_PROVIDER_ATTEMPTS_PER_BATCH };
    let motionStarted = false;
    const startTranslationMotion = async () => {
      if (motionStarted) {
        return;
      }

      motionStarted = true;
      await notifyTranslationPending?.();
    };
    const response = await retryFocusedUnchangedTranslations(
      await requestTranslationsResilient(
        items,
        settings,
        apiKey,
        attemptBudget,
        startTranslationMotion,
        signal,
        deadline
      ),
      items,
      settings,
      apiKey,
      attemptBudget,
      startTranslationMotion,
      signal,
      deadline
    );

    throwIfCancelled(signal);

    if (persistCache && generation === cacheGeneration) {
      for (const item of items) {
        const translation = response.translations.get(item.id);
        const cacheEntry = {
          identity: item.identity,
          translation,
          lastUsed: now
        };

        if (normalizeText(translation) === item.text && response.verifiedUnchangedIds.has(item.id)) {
          cacheEntry.unchangedTranslationVersion = UNCHANGED_TRANSLATION_VERSION;
        } else if (shouldRetryUnchangedTranslation(translation, item)) {
          cacheEntry.unchangedTranslationRetryAfter = Date.now() + UNCHANGED_TRANSLATION_RETRY_MS;
        }

        cache[item.cacheKey] = cacheEntry;
        markCacheEntryDirty(cache, item.cacheKey);
      }

      await saveCache(cache, settings.cacheMaxEntries);
    }

    return {
      apiItems: items.length + Number(response.focusedRetryItems || 0),
      translations: response.translations,
      usage: response.usage
    };
  }

  async function translateBatch(
    rawItems,
    requestedSourceLanguage,
    notifyTranslationPending,
    signal,
    requestScope,
    persistCache
  ) {
    throwIfCancelled(signal);
    const deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS;
    const items = validateItems(rawItems);
    const storedSettings = await getSettings();
    throwIfCancelled(signal);
    const settings = {
      ...storedSettings,
      sourceLanguage: normalizeLanguage(requestedSourceLanguage, storedSettings.sourceLanguage)
    };
    const cache = persistCache ? await getCache() : {};
    const prunedEntries = persistCache ? pruneCache(cache, settings.cacheMaxEntries) : 0;

    if (prunedEntries > 0) {
      await saveCache(cache, settings.cacheMaxEntries);
    }

    const generation = persistCache ? cacheStates.get(cache)?.generation : undefined;
    const now = Date.now();
    const prepared = await Promise.all(items.map(async (item) => {
      const identity = createCacheIdentity({
        model: getSelectedModel(settings),
        provider: settings.provider,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        text: item.text,
        context: item.context,
        kind: item.kind,
        protectedTerms: item.protectedTerms
      });

      return {
        ...item,
        identity,
        cacheKey: await sha256Hex(identity)
      };
    }));
    throwIfCancelled(signal);

    if (persistCache) {
      await loadCacheEntries(cache, prepared.map(({ cacheKey }) => cacheKey));
      throwIfCancelled(signal);
    }

    const translations = new Map();
    const missing = [];
    let cacheHits = 0;
    let cacheMetadataChanged = false;

    for (const item of prepared) {
      const cached = persistCache ? cache[item.cacheKey] : undefined;

      if (cached?.identity === item.identity
        && typeof cached.translation === "string"
        && !shouldRefreshCachedTranslation(cached, item)) {
        translations.set(item.id, cached.translation);

        if (persistCache
          && cacheStates.get(cache)?.generation === cacheGeneration
          && now - Number(cached.lastUsed || 0) >= 3600000) {
          cache[item.cacheKey] = {
            ...cached,
            lastUsed: now
          };
          markCacheEntryDirty(cache, item.cacheKey);
          cacheMetadataChanged = true;
        }

        cacheHits += 1;
      } else {
        missing.push(item);
      }
    }

    let apiItems = 0;
    let usage = null;

    if (missing.length > 0) {
      const ownedKeys = new Set();
      const ownedItems = missing.filter((item) => {
        const flightKey = `${requestScope}:${item.cacheKey}`;

        if (inFlightTranslations.has(flightKey) || ownedKeys.has(flightKey)) {
          return false;
        }

        ownedKeys.add(flightKey);
        return true;
      });
      const ownedFlights = new Map();
      let ownerTask = null;

      if (ownedItems.length > 0) {
        ownerTask = requestMissingTranslations(
          ownedItems,
          settings,
          cache,
          now,
          generation,
          notifyTranslationPending,
          signal,
          persistCache,
          deadline
        );

        for (const item of ownedItems) {
          const flightKey = `${requestScope}:${item.cacheKey}`;
          const flight = ownerTask.then((result) => result.translations.get(item.id));
          ownedFlights.set(flightKey, flight);
          inFlightTranslations.set(flightKey, flight);
        }
      }

      cacheHits += missing.length - ownedItems.length;

      try {
        const [ownerResult, resolvedTranslations] = await Promise.all([
          ownerTask || Promise.resolve(null),
          Promise.all(missing.map((item) => inFlightTranslations.get(`${requestScope}:${item.cacheKey}`)))
        ]);
        throwIfCancelled(signal);

        missing.forEach((item, index) => {
          translations.set(item.id, resolvedTranslations[index]);
        });

        if (ownerResult) {
          apiItems = ownerResult.apiItems;
          usage = ownerResult.usage;
        }
      } finally {
        for (const [cacheKey, flight] of ownedFlights) {
          if (inFlightTranslations.get(cacheKey) === flight) {
            inFlightTranslations.delete(cacheKey);
          }
        }
      }

      if (persistCache
        && ownedItems.length === 0
        && generation === cacheGeneration
        && (cacheMetadataChanged || hasPendingCacheChanges(cache))) {
        await saveCache(cache, settings.cacheMaxEntries);
      }
    } else if (persistCache && (cacheMetadataChanged || hasPendingCacheChanges(cache))) {
      await saveCache(cache, settings.cacheMaxEntries);
    }

    return {
      translations: items.map(({ id }) => ({
        id,
        text: translations.get(id)
      })),
      cacheHits,
      cacheEntries: persistCache ? cacheEntryCount : 0,
      apiItems,
      usage
    };
  }

  async function getPublicSettings(site, includeCacheEntries = false) {
    const [settings, providerKeys] = await Promise.all([
      getSettings(),
      getProviderKeys()
    ]);
    const cache = includeCacheEntries ? await getCache() : undefined;
    const prunedEntries = includeCacheEntries ? pruneCache(cache, settings.cacheMaxEntries) : 0;
    const cacheState = includeCacheEntries ? cacheStates.get(cache) : undefined;
    const cacheBytes = includeCacheEntries
      ? getPhysicalCacheBytes(cacheState)
      : undefined;

    if (prunedEntries > 0) {
      await saveCache(cache, settings.cacheMaxEntries);
    }

    const cacheEntries = includeCacheEntries ? cacheEntryCount : undefined;
    const normalizedSite = normalizeSite(site);
    const siteMode = settings.siteRules[normalizedSite] || "auto";
    const siteViewMode = settings.siteViewModes[normalizedSite] || "default";
    const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([provider, definition]) => [
      provider,
      {
        hasApiKey: Boolean(providerKeys[provider]),
        label: definition.label
      }
    ]));

    return {
      ...(includeCacheEntries ? { cacheBytes, cacheEntries, cacheMaxBytes: MAX_CACHE_BYTES } : {}),
      enabled: siteMode === "always",
      hasApiKey: Boolean(providerKeys[settings.provider]),
      providers,
      site: normalizedSite,
      siteMode,
      siteViewMode,
      settings: {
        animationEnabled: settings.animationEnabled,
        autoTranslateLanguages: settings.autoTranslateLanguages,
        cacheMaxEntries: settings.cacheMaxEntries,
        contextMenuEnabled: settings.contextMenuEnabled,
        defaultViewMode: settings.defaultViewMode,
        model: getSelectedModel(settings),
        provider: settings.provider,
        providerDataConsentVersion: settings.providerDataConsentVersion,
        providerModels: settings.providerModels,
        protectedTerms: settings.protectedTerms,
        selectionButtonEnabled: settings.selectionButtonEnabled,
        siteRules: settings.siteRules,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage
      }
    };
  }

  async function getContentSettings(sender) {
    const settings = await getSettings();
    const topSite = normalizeSite(sender?.tab?.url || "");
    const inheritedOrigin = /^https?:\/\//iu.test(String(sender?.origin || ""))
      ? normalizeSite(sender.origin)
      : "";
    const frameSite = normalizeSite(sender?.url || "") || inheritedOrigin;
    const sameSiteFrame = Boolean(frameSite && frameSite === topSite);
    const inheritsTopSite = sender?.frameId === 0 || sameSiteFrame;
    const site = inheritsTopSite ? topSite || frameSite : frameSite;
    const siteMode = inheritsTopSite
      ? settings.siteRules[site] || "auto"
      : settings.siteRules[site] === "always" ? "always" : "never";
    const viewMode = settings.siteViewModes[site] || settings.defaultViewMode;

    return {
      site,
      siteMode,
      settings: {
        animationEnabled: settings.animationEnabled,
        autoTranslateLanguages: settings.autoTranslateLanguages,
        model: getSelectedModel(settings),
        provider: settings.provider,
        protectedTerms: settings.protectedTerms,
        selectionButtonEnabled: settings.selectionButtonEnabled,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        viewMode
      }
    };
  }

  async function updateSettings(patch) {
    const settings = await mutateSettings((currentSettings) => {
      if (patch && Object.hasOwn(patch, "animationEnabled")) {
        currentSettings.animationEnabled = patch.animationEnabled;
      }

      if (patch && Object.hasOwn(patch, "autoTranslateLanguages")) {
        currentSettings.autoTranslateLanguages = patch.autoTranslateLanguages;
      }

      if (patch && Object.hasOwn(patch, "cacheMaxEntries")) {
        currentSettings.cacheMaxEntries = patch.cacheMaxEntries;
      }

      if (patch && Object.hasOwn(patch, "contextMenuEnabled")) {
        currentSettings.contextMenuEnabled = patch.contextMenuEnabled;
      }

      if (patch && Object.hasOwn(patch, "defaultViewMode")) {
        currentSettings.defaultViewMode = patch.defaultViewMode;
      }

      if (patch && Object.hasOwn(patch, "provider")) {
        currentSettings.provider = patch.provider;
      }

      if (patch && Object.hasOwn(patch, "providerModels")) {
        currentSettings.providerModels = patch.providerModels;
      } else if (patch && Object.hasOwn(patch, "model")) {
        currentSettings.providerModels[currentSettings.provider] = patch.model;
      }

      if (patch && Object.hasOwn(patch, "protectedTerms")) {
        currentSettings.protectedTerms = patch.protectedTerms;
      }

      if (patch && Object.hasOwn(patch, "selectionButtonEnabled")) {
        currentSettings.selectionButtonEnabled = patch.selectionButtonEnabled;
      }

      if (patch && Object.hasOwn(patch, "siteRules")) {
        currentSettings.siteRules = patch.siteRules;
      }

      if (patch && Object.hasOwn(patch, "sourceLanguage")) {
        currentSettings.sourceLanguage = patch.sourceLanguage;
      }

      if (patch && Object.hasOwn(patch, "targetLanguage")) {
        currentSettings.targetLanguage = patch.targetLanguage;
      }

      return currentSettings;
    });

    if (patch && Object.hasOwn(patch, "contextMenuEnabled")) {
      await runSettingsWrite(async () => {
        const currentSettings = await getSettings();
        await registerContextMenu(currentSettings.contextMenuEnabled);
      });
    }

    return settings;
  }

  async function validateSitePreferenceTarget(site, tabId) {
    const normalizedSite = normalizeSite(site);

    if (!normalizedSite) {
      throw new Error("This page cannot save website preferences.");
    }

    if (Number.isInteger(tabId)) {
      const tab = await api.tabs.get(tabId);

      if (tab?.incognito) {
        throw new Error("Website preferences are not saved from private tabs.");
      }

      if (normalizeSite(tab?.url || "") !== normalizedSite) {
        throw new Error("The active tab no longer matches this website.");
      }
    }

    return normalizedSite;
  }

  async function setSiteMode(site, mode, includeCacheEntries = false, tabId) {
    const normalizedSite = await validateSitePreferenceTarget(site, tabId);
    await mutateSettings((settings) => {
      if (mode === "always" || mode === "never") {
        settings.siteRules[normalizedSite] = mode;
      } else {
        delete settings.siteRules[normalizedSite];
      }
    });
    return getPublicSettings(normalizedSite, includeCacheEntries);
  }

  async function setSiteViewMode(site, viewMode, includeCacheEntries = false, tabId) {
    const normalizedSite = await validateSitePreferenceTarget(site, tabId);
    await mutateSettings((settings) => {
      if (viewMode === "bilingual" || viewMode === "translated") {
        settings.siteViewModes[normalizedSite] = viewMode;
      } else {
        delete settings.siteViewModes[normalizedSite];
      }
    });
    return getPublicSettings(normalizedSite, includeCacheEntries);
  }

  async function updateProviderKey(providerValue, action, value, consent, consentVersion) {
    const provider = normalizeProvider(providerValue);
    let apiKey = "";

    if (action !== "clear") {
      assertProviderDataConsent(consent, consentVersion);
      apiKey = String(value ?? "").trim();

      if (action !== "set" || apiKey.length < 20) {
        throw new Error(`Enter a valid ${PROVIDERS[provider].label} API key.`);
      }
    }

    providerModelCache.delete(provider);
    await runSettingsWrite(async () => {
      const keys = await getProviderKeys();
      let settings;

      if (action === "clear") {
        delete keys[provider];
      } else {
        keys[provider] = apiKey;
        settings = await getSettings();
        settings.providerDataConsentVersion = PROVIDER_DATA_CONSENT_VERSION;
      }

      await api.storage.local.set({
        [PROVIDER_KEYS_KEY]: keys,
        ...(settings ? { [SETTINGS_KEY]: sanitizeSettings(settings) } : {})
      });

      if (provider === "deepseek") {
        await api.storage.local.remove(LEGACY_DEEPSEEK_KEY);
      }
    });

    await broadcastSettings();
  }

  async function clearCache() {
    cacheGeneration += 1;
    clearTimeout(cacheIndexFlushTimer);
    cacheIndexFlushTimer = undefined;
    clearTimeout(cacheReleaseTimer);
    inFlightTranslations.clear();
    const cache = {};
    const index = { entries: {} };
    initializeCacheState(cache, index, cacheGeneration);
    cachePromise = Promise.resolve(cache);
    cacheWritePromise = cacheWritePromise
      .catch(() => undefined)
      .then(async () => {
        const stored = await api.storage.local.get(null);
        const storedEntryKeys = Object.keys(stored).filter((key) => (
          key === CACHE_KEY
          || key === CACHE_INDEX_KEY
          || key === CACHE_INDEX_DIRTY_KEY
          || key.startsWith(CACHE_ENTRY_PREFIX)
        ));
        await removeStorageKeys(storedEntryKeys);
        await api.storage.local.set({ [CACHE_INDEX_KEY]: serializeCacheIndex(index) });
      });
    await cacheWritePromise;
  }

  async function getCacheStats() {
    await getCache();
    return { cacheEntries: cacheEntryCount };
  }

  async function fetchProviderModels(
    provider,
    apiKey,
    deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS
  ) {
    const definition = PROVIDERS[provider];
    const body = await fetchJsonWithRetry(getModelsUrl(provider), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    }, definition.label, undefined, undefined, deadline);
    const models = filterProviderModels(provider, body?.data?.map(({ id }) => id));

    if (models.length === 0) {
      throw new Error(`${definition.label} did not return a compatible text model.`);
    }

    return models;
  }

  async function listProviderModels(
    providerValue,
    force = false,
    deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS
  ) {
    const provider = normalizeProvider(providerValue);
    const settings = await getSettings();
    assertStoredProviderDataConsent(settings);
    const cached = providerModelCache.get(provider);

    if (!force && cached?.expiresAt > Date.now()) {
      return { models: cached.models, provider };
    }

    const apiKey = await getProviderKey(provider);

    if (!apiKey) {
      throw new Error(`No ${PROVIDERS[provider].label} API key is configured.`);
    }

    const models = await fetchProviderModels(provider, apiKey, deadline);
    providerModelCache.set(provider, {
      expiresAt: Date.now() + 300000,
      models
    });
    return { models, provider };
  }

  async function probeProviderConnection(provider, model, apiKey, models, deadline) {
    const definition = PROVIDERS[provider];

    if (!models.includes(model)) {
      throw new Error(`The configured model ${model} is not available for this ${definition.label} key.`);
    }

    const request = buildProviderRequest(provider, {
      maxTokens: 32,
      messages: [{ role: "user", content: "Return JSON only: {\"ok\":true}" }],
      model
    });
    await fetchJsonWithRetry(request.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.body)
    }, definition.label, undefined, undefined, deadline);
  }

  async function testProviderConnection(providerValue, modelValue) {
    const provider = normalizeProvider(providerValue);
    const deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS;
    const { models } = await listProviderModels(provider, true, deadline);
    const settings = await getSettings();
    const model = String(modelValue || settings.providerModels[provider]);
    const apiKey = await getProviderKey(provider);
    await probeProviderConnection(provider, model, apiKey, models, deadline);

    return { model, provider };
  }

  async function configureProvider(
    providerValue,
    apiKeyValue,
    targetLanguageValue,
    consent,
    consentVersion
  ) {
    assertProviderDataConsent(consent, consentVersion);
    const deadline = Date.now() + NETWORK_TOTAL_DEADLINE_MS;
    const provider = normalizeProvider(providerValue);
    const initialKeys = await getProviderKeys();
    const candidateApiKey = String(apiKeyValue || "").trim();
    const apiKey = candidateApiKey || initialKeys[provider] || "";

    if (apiKey.length < 20) {
      throw new Error(`Enter a valid ${PROVIDERS[provider].label} API key.`);
    }

    const [settings, models] = await Promise.all([
      getSettings(),
      fetchProviderModels(provider, apiKey, deadline)
    ]);
    const configuredModel = settings.providerModels[provider];
    const model = models.includes(configuredModel) ? configuredModel : models[0];
    await probeProviderConnection(provider, model, apiKey, models, deadline);

    await runSettingsWrite(async () => {
      const [latestKeys, latestSettings] = await Promise.all([
        getProviderKeys(),
        getSettings()
      ]);

      if (!candidateApiKey && latestKeys[provider] !== apiKey) {
        throw new Error(`${PROVIDERS[provider].label} configuration changed. Try again.`);
      }

      latestKeys[provider] = apiKey;
      const nextSettings = sanitizeSettings({
        ...latestSettings,
        provider,
        providerDataConsentVersion: PROVIDER_DATA_CONSENT_VERSION,
        providerModels: {
          ...latestSettings.providerModels,
          [provider]: model
        },
        targetLanguage: targetLanguageValue
      });
      await api.storage.local.set({
        [PROVIDER_KEYS_KEY]: latestKeys,
        [SETTINGS_KEY]: nextSettings
      });

      if (provider === "deepseek") {
        await api.storage.local.remove(LEGACY_DEEPSEEK_KEY);
      }
    });

    providerModelCache.set(provider, {
      expiresAt: Date.now() + 300000,
      models
    });
    await broadcastSettings();
    return { model, models, provider };
  }

  function getTranslationRequestScope(sender) {
    const tabId = sender?.tab?.id;

    if (tabId == null) {
      return "";
    }

    return `${tabId}:${sender.frameId ?? 0}`;
  }

  async function cancelTranslationRequests(sender) {
    const requestScope = getTranslationRequestScope(sender);

    if (!requestScope) {
      return { cancelled: 0 };
    }

    const requests = [...activeTranslationRequests].filter((request) => (
      request.scope === requestScope && !request.controller.signal.aborted
    ));

    for (const request of requests) {
      request.controller.abort();
    }

    await Promise.allSettled(requests.map(({ promise }) => promise));
    return { cancelled: requests.length };
  }

  async function registerContextMenu(enabled = true) {
    for (const menuId of [CONTEXT_MENU_ID, ...LEGACY_CONTEXT_MENU_IDS]) {
      try {
        await api.contextMenus.remove(menuId);
      } catch {
        // The menu is absent on a fresh installation.
      }
    }

    if (!enabled) {
      return;
    }

    api.contextMenus.create({
      contexts: ["selection", "editable"],
      id: CONTEXT_MENU_ID,
      title: api.i18n.getMessage("contextTranslateText") || "Translate text"
    });
  }

  api.runtime.onInstalled.addListener(async (details) => {
    await storageAccessPromise;
    const stored = await api.storage.local.get([SETTINGS_KEY, ONBOARDING_VERSION_KEY]);

    const settings = stored[SETTINGS_KEY]
      ? await getSettings()
      : await saveSettings(DEFAULT_SETTINGS);
    await registerContextMenu(settings.contextMenuEnabled);

    if (details?.reason === "install" && stored[ONBOARDING_VERSION_KEY] !== SETTINGS_VERSION) {
      await api.storage.local.set({ [ONBOARDING_VERSION_KEY]: SETTINGS_VERSION });
      await api.tabs.create({ url: api.runtime.getURL("onboarding/onboarding.html") });
    }
  });

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.id == null) {
      return;
    }

    if (info.menuItemId !== CONTEXT_MENU_ID) {
      return;
    }

    const message = info.editable === true
      ? { type: "translateEditable" }
      : {
        type: "translateSelection",
        text: typeof info.selectionText === "string" ? info.selectionText : ""
      };
    void api.tabs.sendMessage(
      tab.id,
      message,
      { frameId: info.frameId ?? 0 }
    ).catch(() => undefined);
  });

  api.commands.onCommand.addListener(async (command) => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });

    if (tab?.id == null) {
      return;
    }

    const messageType = {
      "cycle-view-mode": "cycleViewMode",
      "toggle-translation": "toggleTranslation",
      "translate-editable": "translateEditable"
    }[command];

    if (messageType === "translateEditable") {
      await api.tabs.sendMessage(tab.id, { type: messageType }).catch(() => undefined);
    } else if (messageType) {
      await api.tabs.sendMessage(tab.id, { type: messageType }, { frameId: 0 }).catch(() => undefined);
    }
  });

  function handleMessage(message, sender) {
    const trustedSender = typeof sender?.url === "string"
      && sender.url.startsWith(api.runtime.getURL(""));

    if (!trustedSender && PRIVILEGED_MESSAGE_TYPES.has(message?.type)) {
      throw new Error("This action is only available to trusted extension pages.");
    }

    switch (message?.type) {
      case "translateBatch": {
        const controller = new AbortController();
        const requestScope = getTranslationRequestScope(sender);
        const activeRequest = { controller, scope: requestScope };
        const motionId = typeof message.motionId === "string" && /^[\w:-]{1,64}$/u.test(message.motionId)
          ? message.motionId
          : "";
        const notifyTranslationPending = motionId && sender.tab?.id != null
          ? () => (
            api.tabs.sendMessage(
              sender.tab.id,
              { type: "translationMotionStart", motionId },
              { frameId: sender.frameId ?? 0 }
            ).catch(() => undefined)
          )
          : undefined;
        activeTranslationRequests.add(activeRequest);
        activeRequest.promise = translateBatch(
          message.items,
          message.sourceLanguage,
          notifyTranslationPending,
          controller.signal,
          requestScope,
          sender?.tab?.incognito !== true && message.persistCache !== false
        ).finally(() => activeTranslationRequests.delete(activeRequest));
        return activeRequest.promise;
      }
      case "cancelTranslations":
        return cancelTranslationRequests(sender);
      case "configureProvider":
        return configureProvider(
          message.provider,
          message.apiKey,
          message.targetLanguage,
          message.providerDataConsent,
          message.providerDataConsentVersion
        );
      case "getSettings":
        return trustedSender
          ? getPublicSettings(message.site, message.includeCacheEntries === true)
          : getContentSettings(sender);
      case "getCacheStats":
        return getCacheStats();
      case "updateSettings":
        return updateSettings(message.settings)
          .then(() => getPublicSettings(message.site, message.includeCacheEntries === true));
      case "setSiteMode":
        return setSiteMode(
          message.site,
          message.mode,
          message.includeCacheEntries === true,
          message.tabId
        );
      case "setSiteViewMode":
        return setSiteViewMode(
          message.site,
          message.viewMode,
          message.includeCacheEntries === true,
          message.tabId
        );
      case "updateProviderKey":
        return updateProviderKey(
          message.provider,
          message.action,
          message.apiKey,
          message.providerDataConsent,
          message.providerDataConsentVersion
        )
          .then(() => getPublicSettings(message.site, message.includeCacheEntries === true));
      case "listProviderModels":
        return listProviderModels(message.provider, message.force === true);
      case "clearCache":
        return clearCache().then(() => ({ cacheBytes: 0, cacheEntries: 0 }));
      case "detectLanguage":
        return api.i18n.detectLanguage(String(message.text || "").slice(0, 6000));
      case "testProviderConnection":
        return testProviderConnection(message.provider, message.model);
      case "translationStatus":
        if (sender.tab?.id != null && sender.frameId === 0) {
          const text = message.status?.error ? "!" : message.status?.translating ? "…" : "";
          void Promise.all([
            api.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: message.status?.error ? "#c9344a" : "#6157ff" }),
            api.action.setBadgeText({ tabId: sender.tab.id, text })
          ]).catch(() => undefined);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  api.runtime.onMessage.addListener((message, sender) => (
    storageAccessPromise.then(() => handleMessage(message, sender))
  ));
})();
