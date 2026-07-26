(function initializeBackground() {
  const api = globalThis.browser;
  const {
    buildMessages,
    createCacheIdentity,
    estimateCacheBytes,
    maskProtectedTerms,
    MAX_CACHE_BYTES,
    normalizeText,
    parseTranslationJson,
    pruneCacheEntries,
    restoreProtectedTerms,
    setCacheEntry,
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
  const CONTEXT_MENU_SELECTION_ID = "translate-selection";
  const CONTEXT_MENU_EDITABLE_ID = "translate-editable";
  const ONBOARDING_VERSION_KEY = "onboardingShownVersion";
  const SETTINGS_VERSION = 2;
  const DEFAULT_SETTINGS = Object.freeze({
    animationEnabled: true,
    autoTranslateLanguages: [],
    cacheMaxEntries: 16000,
    provider: "deepseek",
    providerModels: Object.freeze({
      deepseek: PROVIDERS.deepseek.defaultModel,
      openai: PROVIDERS.openai.defaultModel
    }),
    protectedTerms: [],
    siteRules: {},
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
  const NETWORK_TIMEOUT_MS = 45000;
  const PRIVILEGED_MESSAGE_TYPES = new Set([
    "clearCache",
    "configureProvider",
    "getCacheStats",
    "listProviderModels",
    "setSiteMode",
    "testProviderConnection",
    "updateProviderKey",
    "updateSettings"
  ]);
  let cachePromise;
  let cacheReleaseTimer;
  let cacheWritePromise = Promise.resolve();
  let cacheGeneration = 0;
  let cacheEntryCount = 0;
  let cacheEstimatedBytes = 2;
  let activeRequestCount = 0;
  const activeTranslationRequests = new Set();
  const cacheStates = new WeakMap();
  const inFlightTranslations = new Map();
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
      provider,
      providerModels,
      protectedTerms: normalizeProtectedTerms(value?.protectedTerms),
      siteRules: normalizeSiteRules(value?.siteRules, value?.enabledSites),
      sourceLanguage: normalizeLanguage(value?.sourceLanguage, DEFAULT_SETTINGS.sourceLanguage),
      targetLanguage: normalizeLanguage(value?.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
      version: SETTINGS_VERSION
    };
  }

  async function getSettings() {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    const current = stored[SETTINGS_KEY];
    const migrated = current && Number(current.version || 0) < SETTINGS_VERSION
      ? {
        ...current,
        cacheMaxEntries: Number(current.cacheMaxEntries) === 8000
          ? DEFAULT_SETTINGS.cacheMaxEntries
          : current.cacheMaxEntries,
        version: SETTINGS_VERSION
      }
      : current;
    const settings = sanitizeSettings(migrated ?? DEFAULT_SETTINGS);

    if (current && Number(current.version || 0) < SETTINGS_VERSION) {
      await api.storage.local.set({ [SETTINGS_KEY]: settings });
    }

    return settings;
  }

  async function saveSettings(settings) {
    const sanitized = sanitizeSettings(settings);
    await api.storage.local.set({ [SETTINGS_KEY]: sanitized });
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

  async function removeStorageKeys(keys) {
    for (let index = 0; index < keys.length; index += 500) {
      await api.storage.local.remove(keys.slice(index, index + 500));
    }
  }

  async function getCache() {
    if (!cachePromise) {
      const generation = cacheGeneration;
      cachePromise = api.storage.local.get(null).then(async (stored) => {
        const legacyCache = stored[CACHE_KEY];
        const normalizedCache = legacyCache && typeof legacyCache === "object" && !Array.isArray(legacyCache)
          ? { ...legacyCache }
          : {};

        for (const [key, entry] of Object.entries(stored)) {
          if (key.startsWith(CACHE_ENTRY_PREFIX) && key.length > CACHE_ENTRY_PREFIX.length) {
            normalizedCache[key.slice(CACHE_ENTRY_PREFIX.length)] = entry;
          }
        }

        cacheStates.set(normalizedCache, {
          dirtyKeys: new Set(),
          generation,
          removedKeys: new Set()
        });

        if (generation === cacheGeneration) {
          cacheEntryCount = Object.keys(normalizedCache).length;
          cacheEstimatedBytes = estimateCacheBytes(normalizedCache);
        }

        if (legacyCache && typeof legacyCache === "object" && !Array.isArray(legacyCache)) {
          const migratedEntries = Object.fromEntries(Object.entries(normalizedCache).map(([key, entry]) => [
            getCacheEntryStorageKey(key),
            entry
          ]));
          cacheWritePromise = cacheWritePromise
            .catch(() => undefined)
            .then(async () => {
              if (generation !== cacheGeneration) {
                return;
              }

              if (Object.keys(migratedEntries).length > 0) {
                await api.storage.local.set(migratedEntries);
              }

              if (generation === cacheGeneration) {
                await removeStorageKeys([CACHE_KEY]);
              }
            });
          await cacheWritePromise;
        }

        return normalizedCache;
      });
    }

    scheduleCacheRelease();

    return cachePromise;
  }

  function pruneCache(cache, maximumEntries) {
    const state = cacheStates.get(cache);

    if (state?.generation !== cacheGeneration) {
      return 0;
    }

    if (cacheEntryCount <= maximumEntries && cacheEstimatedBytes <= MAX_CACHE_BYTES) {
      return 0;
    }

    const result = pruneCacheEntries(
      cache,
      maximumEntries,
      MAX_CACHE_BYTES,
      cacheEstimatedBytes
    );

    for (const key of result.removedKeys) {
      state.dirtyKeys.delete(key);
      state.removedKeys.add(key);
    }

    cacheEntryCount = Math.max(0, cacheEntryCount - result.removedEntries);
    cacheEstimatedBytes = result.bytes;
    return result.removedEntries;
  }

  function markCacheEntryDirty(cache, key) {
    const state = cacheStates.get(cache);

    if (state?.generation !== cacheGeneration) {
      return;
    }

    state.removedKeys.delete(key);
    state.dirtyKeys.add(key);
  }

  function hasPendingCacheChanges(cache) {
    const state = cacheStates.get(cache);
    return state?.generation === cacheGeneration
      && (state.dirtyKeys.size > 0 || state.removedKeys.size > 0);
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
          if (Object.keys(dirtyEntries).length > 0) {
            await api.storage.local.set(dirtyEntries);
          }

          if (generation === cacheGeneration && removedKeys.length > 0) {
            await removeStorageKeys(removedKeys);
          }
        } catch (error) {
          if (generation === cacheGeneration) {
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

  async function fetchJsonWithRetry(
    url,
    options,
    providerLabel = "Translation provider",
    beforeAttempt,
    signal
  ) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfCancelled(signal);
      const controller = new AbortController();
      let timedOut = false;
      const handleAbort = () => controller.abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, NETWORK_TIMEOUT_MS);
      signal?.addEventListener("abort", handleAbort, { once: true });

      try {
        await beforeAttempt?.();
        throwIfCancelled(signal);
        const response = await fetch(url, { ...options, signal: controller.signal });

        if (response.ok) {
          return await response.json();
        }

        if (response.status !== 429 && response.status < 500) {
          const error = new Error(await readApiError(response, providerLabel));
          error.retryable = false;
          throw error;
        }

        lastError = new Error(`${providerLabel} temporarily returned HTTP ${response.status}.`);
      } catch (error) {
        throwIfCancelled(signal);
        lastError = error?.name === "AbortError" && timedOut
          ? new Error(`${providerLabel} request timed out.`)
          : error;

        if (attempt === 2
          || lastError?.retryable === false
          || !/temporarily|timed out|network|fetch|429|5\d\d/iu.test(String(lastError?.message))) {
          throw lastError;
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", handleAbort);
      }

      await delay(700 * (attempt + 1), signal);
    }

    throw lastError || new Error(`${providerLabel} request failed.`);
  }

  async function requestTranslations(
    items,
    settings,
    apiKey,
    attemptBudget,
    notifyTranslationPending,
    signal
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
    }, signal);
    const content = body?.choices?.[0]?.message?.content;
    const finishReason = body?.choices?.[0]?.finish_reason;

    if (finishReason === "length") {
      const error = new Error(`${providerDefinition.label} response reached its output limit.`);
      error.canSplitBatch = true;
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
    emptyResponseRetries = 1
  ) {
    try {
      return await withRequestSlot(() => requestTranslations(
        items,
        settings,
        apiKey,
        attemptBudget,
        notifyTranslationPending,
        signal
      ), signal);
    } catch (error) {
      if (error?.canRetryEmptyResponse && emptyResponseRetries > 0) {
        return requestTranslationsResilient(
          items,
          settings,
          apiKey,
          attemptBudget,
          notifyTranslationPending,
          signal,
          emptyResponseRetries - 1
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
          signal
        ),
        requestTranslationsResilient(
          items.slice(midpoint),
          settings,
          apiKey,
          attemptBudget,
          notifyTranslationPending,
          signal
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
    signal
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
    }, apiKey, attemptBudget, notifyTranslationPending, signal)));
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
    persistCache
  ) {
    throwIfCancelled(signal);
    const provider = normalizeProvider(settings.provider);
    const apiKey = await getProviderKey(provider);

    if (!apiKey) {
      throw new Error(`No ${PROVIDERS[provider].label} API key is configured. Open the extension settings.`);
    }

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
        signal
      ),
      items,
      settings,
      apiKey,
      attemptBudget,
      startTranslationMotion,
      signal
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

        if (!Object.hasOwn(cache, item.cacheKey)) {
          cacheEntryCount += 1;
        }

        cacheEstimatedBytes = setCacheEntry(cache, item.cacheKey, cacheEntry, cacheEstimatedBytes);
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
          cacheEstimatedBytes = setCacheEntry(cache, item.cacheKey, {
            ...cached,
            lastUsed: now
          }, cacheEstimatedBytes);
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
          persistCache
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
    const cacheBytes = includeCacheEntries ? cacheEstimatedBytes : undefined;

    if (prunedEntries > 0) {
      await saveCache(cache, settings.cacheMaxEntries);
    }

    const cacheEntries = includeCacheEntries ? cacheEntryCount : undefined;
    const normalizedSite = normalizeSite(site);
    const siteMode = settings.siteRules[normalizedSite] || "auto";
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
      settings: {
        animationEnabled: settings.animationEnabled,
        autoTranslateLanguages: settings.autoTranslateLanguages,
        cacheMaxEntries: settings.cacheMaxEntries,
        model: getSelectedModel(settings),
        provider: settings.provider,
        providerModels: settings.providerModels,
        protectedTerms: settings.protectedTerms,
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

    return {
      site,
      siteMode,
      settings: {
        animationEnabled: settings.animationEnabled,
        autoTranslateLanguages: settings.autoTranslateLanguages,
        model: getSelectedModel(settings),
        provider: settings.provider,
        protectedTerms: settings.protectedTerms,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage
      }
    };
  }

  async function updateSettings(patch) {
    const settings = await getSettings();

    if (patch && Object.hasOwn(patch, "animationEnabled")) {
      settings.animationEnabled = patch.animationEnabled;
    }

    if (patch && Object.hasOwn(patch, "autoTranslateLanguages")) {
      settings.autoTranslateLanguages = patch.autoTranslateLanguages;
    }

    if (patch && Object.hasOwn(patch, "cacheMaxEntries")) {
      settings.cacheMaxEntries = patch.cacheMaxEntries;
    }

    if (patch && Object.hasOwn(patch, "provider")) {
      settings.provider = patch.provider;
    }

    if (patch && Object.hasOwn(patch, "providerModels")) {
      settings.providerModels = patch.providerModels;
    } else if (patch && Object.hasOwn(patch, "model")) {
      settings.providerModels[settings.provider] = patch.model;
    }

    if (patch && Object.hasOwn(patch, "protectedTerms")) {
      settings.protectedTerms = patch.protectedTerms;
    }

    if (patch && Object.hasOwn(patch, "siteRules")) {
      settings.siteRules = patch.siteRules;
    }

    if (patch && Object.hasOwn(patch, "sourceLanguage")) {
      settings.sourceLanguage = patch.sourceLanguage;
    }

    if (patch && Object.hasOwn(patch, "targetLanguage")) {
      settings.targetLanguage = patch.targetLanguage;
    }

    return saveSettings(settings);
  }

  async function setSiteMode(site, mode, includeCacheEntries = false, tabId) {
    const normalizedSite = normalizeSite(site);

    if (!normalizedSite) {
      throw new Error("This page cannot be enabled for translation.");
    }

    if (Number.isInteger(tabId)) {
      const tab = await api.tabs.get(tabId);

      if (tab?.incognito) {
        throw new Error("Website rules are not saved from private tabs. Use one-time translation instead.");
      }

      if (normalizeSite(tab?.url || "") !== normalizedSite) {
        throw new Error("The active tab no longer matches this website.");
      }
    }

    const settings = await getSettings();

    if (mode === "always" || mode === "never") {
      settings.siteRules[normalizedSite] = mode;
    } else {
      delete settings.siteRules[normalizedSite];
    }

    await saveSettings(settings);
    return getPublicSettings(normalizedSite, includeCacheEntries);
  }

  async function updateProviderKey(providerValue, action, value) {
    const provider = normalizeProvider(providerValue);
    const keys = await getProviderKeys();

    if (action === "clear") {
      delete keys[provider];
    } else {
      const apiKey = String(value ?? "").trim();

      if (action !== "set" || apiKey.length < 20) {
        throw new Error(`Enter a valid ${PROVIDERS[provider].label} API key.`);
      }

      keys[provider] = apiKey;
    }

    providerModelCache.delete(provider);
    await api.storage.local.set({ [PROVIDER_KEYS_KEY]: keys });

    if (provider === "deepseek") {
      await api.storage.local.remove(LEGACY_DEEPSEEK_KEY);
    }

    await broadcastSettings();
  }

  async function clearCache() {
    cacheGeneration += 1;
    clearTimeout(cacheReleaseTimer);
    inFlightTranslations.clear();
    const cache = {};
    cacheStates.set(cache, {
      dirtyKeys: new Set(),
      generation: cacheGeneration,
      removedKeys: new Set()
    });
    cachePromise = Promise.resolve(cache);
    cacheEntryCount = 0;
    cacheEstimatedBytes = 2;
    cacheWritePromise = cacheWritePromise
      .catch(() => undefined)
      .then(async () => {
        const stored = await api.storage.local.get(null);
        const keys = Object.keys(stored).filter((key) => key === CACHE_KEY || key.startsWith(CACHE_ENTRY_PREFIX));
        await removeStorageKeys(keys);
      });
    await cacheWritePromise;
  }

  async function getCacheStats() {
    await getCache();
    return { cacheEntries: cacheEntryCount };
  }

  async function fetchProviderModels(provider, apiKey) {
    const definition = PROVIDERS[provider];
    const body = await fetchJsonWithRetry(getModelsUrl(provider), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    }, definition.label);
    const models = filterProviderModels(provider, body?.data?.map(({ id }) => id));

    if (models.length === 0) {
      throw new Error(`${definition.label} did not return a compatible text model.`);
    }

    return models;
  }

  async function listProviderModels(providerValue, force = false) {
    const provider = normalizeProvider(providerValue);
    const cached = providerModelCache.get(provider);

    if (!force && cached?.expiresAt > Date.now()) {
      return { models: cached.models, provider };
    }

    const apiKey = await getProviderKey(provider);

    if (!apiKey) {
      throw new Error(`No ${PROVIDERS[provider].label} API key is configured.`);
    }

    const models = await fetchProviderModels(provider, apiKey);
    providerModelCache.set(provider, {
      expiresAt: Date.now() + 300000,
      models
    });
    return { models, provider };
  }

  async function probeProviderConnection(provider, model, apiKey, models) {
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
    }, definition.label);
  }

  async function testProviderConnection(providerValue, modelValue) {
    const provider = normalizeProvider(providerValue);
    const { models } = await listProviderModels(provider, true);
    const settings = await getSettings();
    const model = String(modelValue || settings.providerModels[provider]);
    const apiKey = await getProviderKey(provider);
    await probeProviderConnection(provider, model, apiKey, models);

    return { model, provider };
  }

  async function configureProvider(providerValue, apiKeyValue, targetLanguageValue) {
    const provider = normalizeProvider(providerValue);
    const initialKeys = await getProviderKeys();
    const candidateApiKey = String(apiKeyValue || "").trim();
    const apiKey = candidateApiKey || initialKeys[provider] || "";

    if (apiKey.length < 20) {
      throw new Error(`Enter a valid ${PROVIDERS[provider].label} API key.`);
    }

    const [settings, models] = await Promise.all([
      getSettings(),
      fetchProviderModels(provider, apiKey)
    ]);
    const configuredModel = settings.providerModels[provider];
    const model = models.includes(configuredModel) ? configuredModel : models[0];
    await probeProviderConnection(provider, model, apiKey, models);

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

  async function registerContextMenu() {
    for (const menuId of [CONTEXT_MENU_SELECTION_ID, CONTEXT_MENU_EDITABLE_ID]) {
      try {
        await api.contextMenus.remove(menuId);
      } catch {
        // The menu is absent on a fresh installation.
      }
    }

    api.contextMenus.create({
      contexts: ["selection"],
      id: CONTEXT_MENU_SELECTION_ID,
      title: api.i18n.getMessage("contextTranslateSelection") || "Translate selection"
    });
    api.contextMenus.create({
      contexts: ["editable"],
      id: CONTEXT_MENU_EDITABLE_ID,
      title: api.i18n.getMessage("contextTranslateEditable") || "Translate this field"
    });
  }

  api.runtime.onInstalled.addListener(async (details) => {
    await storageAccessPromise;
    const stored = await api.storage.local.get([SETTINGS_KEY, ONBOARDING_VERSION_KEY]);

    if (!stored[SETTINGS_KEY]) {
      await saveSettings(DEFAULT_SETTINGS);
    }

    await registerContextMenu();

    if (details?.reason === "install" && stored[ONBOARDING_VERSION_KEY] !== SETTINGS_VERSION) {
      await api.storage.local.set({ [ONBOARDING_VERSION_KEY]: SETTINGS_VERSION });
      await api.tabs.create({ url: api.runtime.getURL("onboarding/onboarding.html") });
    }
  });

  api.contextMenus.onClicked.addListener((info, tab) => {
    if (tab?.id == null) {
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_SELECTION_ID
      && info.editable !== true
      && typeof info.selectionText === "string") {
      void api.tabs.sendMessage(
        tab.id,
        {
          type: "translateSelection",
          text: info.selectionText
        },
        { frameId: info.frameId ?? 0 }
      ).catch(() => undefined);
    } else if (info.menuItemId === CONTEXT_MENU_EDITABLE_ID && info.editable === true) {
      void api.tabs.sendMessage(
        tab.id,
        {
          type: "translateEditable",
          text: typeof info.selectionText === "string" ? info.selectionText : ""
        },
        { frameId: info.frameId ?? 0 }
      ).catch(() => undefined);
    }
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
        return configureProvider(message.provider, message.apiKey, message.targetLanguage);
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
      case "updateProviderKey":
        return updateProviderKey(message.provider, message.action, message.apiKey)
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
