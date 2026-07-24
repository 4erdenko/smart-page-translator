(function initializeOptions() {
  const api = globalThis.browser;
  let cacheMaximumBytes = 16 * 1024 * 1024;
  let currentProvider = "deepseek";
  let providerModels = {};
  let providerStatuses = {};
  const availableModels = {};
  const elements = {
    alwaysSites: document.querySelector("#alwaysSites"),
    animationEnabled: document.querySelector("#animationEnabled"),
    apiKey: document.querySelector("#apiKey"),
    autoLanguageInputs: [...document.querySelectorAll('input[name="autoTranslateLanguage"]')],
    cacheCount: document.querySelector("#cacheCount"),
    cacheMaxEntries: document.querySelector("#cacheMaxEntries"),
    clearCacheButton: document.querySelector("#clearCacheButton"),
    clearKeyButton: document.querySelector("#clearKeyButton"),
    form: document.querySelector("#settingsForm"),
    keyBadge: document.querySelector("#keyBadge"),
    keyHint: document.querySelector("#keyHint"),
    model: document.querySelector("#model"),
    neverSites: document.querySelector("#neverSites"),
    provider: document.querySelector("#provider"),
    refreshModelsButton: document.querySelector("#refreshModelsButton"),
    saveStatus: document.querySelector("#saveStatus"),
    sourceLanguage: document.querySelector("#sourceLanguage"),
    targetLanguage: document.querySelector("#targetLanguage"),
    testButton: document.querySelector("#testButton")
  };

  function normalizeSite(value) {
    try {
      const candidate = String(value || "").trim();
      const url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(candidate) ? candidate : `https://${candidate}`);
      return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch {
      return "";
    }
  }

  function buildSiteRules() {
    const rules = {};

    for (const site of elements.alwaysSites.value.split(/\r?\n/u).map(normalizeSite).filter(Boolean)) {
      rules[site] = "always";
    }

    for (const site of elements.neverSites.value.split(/\r?\n/u).map(normalizeSite).filter(Boolean)) {
      rules[site] = "never";
    }

    return rules;
  }

  function renderSiteRules(siteRules) {
    const entries = Object.entries(siteRules || {}).sort(([left], [right]) => left.localeCompare(right));
    elements.alwaysSites.value = entries.filter(([, mode]) => mode === "always").map(([site]) => site).join("\n");
    elements.neverSites.value = entries.filter(([, mode]) => mode === "never").map(([site]) => site).join("\n");
  }

  function getProviderLabel(provider) {
    return providerStatuses[provider]?.label || (provider === "openai" ? "OpenAI" : "DeepSeek");
  }

  function renderModelOptions(provider) {
    const selected = providerModels[provider] || "";
    const models = availableModels[provider]?.length > 0 ? availableModels[provider] : [selected].filter(Boolean);
    elements.model.replaceChildren(...models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      return option;
    }));

    if (models.includes(selected)) {
      elements.model.value = selected;
    } else if (models.length > 0) {
      elements.model.value = models[0];
      providerModels[provider] = models[0];
    }
  }

  function renderProviderState(provider) {
    const configured = Boolean(providerStatuses[provider]?.hasApiKey);
    const label = getProviderLabel(provider);
    elements.keyBadge.className = `badge ${configured ? "success" : "error"}`;
    elements.keyBadge.textContent = configured ? `${label} key configured` : `${label} key missing`;
    elements.clearKeyButton.disabled = !configured;
    elements.keyHint.textContent = configured
      ? `The ${label} key is stored locally. Enter a replacement only when you want to rotate it.`
      : `Enter a ${label} API key, then load the models available to this account.`;
    renderModelOptions(provider);
  }

  function formatMiB(bytes) {
    return `${(Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function render(response) {
    const automaticLanguages = new Set(response.settings.autoTranslateLanguages || []);
    providerModels = { ...response.settings.providerModels };
    providerStatuses = { ...response.providers };
    currentProvider = response.settings.provider;
    elements.provider.value = currentProvider;
    elements.animationEnabled.checked = response.settings.animationEnabled !== false;
    elements.sourceLanguage.value = response.settings.sourceLanguage;
    elements.targetLanguage.value = response.settings.targetLanguage;
    elements.cacheMaxEntries.value = String(response.settings.cacheMaxEntries);
    cacheMaximumBytes = Number(response.cacheMaxBytes) || cacheMaximumBytes;
    elements.cacheCount.textContent = `${response.cacheEntries || 0} phrases · ${formatMiB(response.cacheBytes)} / ${formatMiB(cacheMaximumBytes)}`;

    for (const input of elements.autoLanguageInputs) {
      input.checked = automaticLanguages.has(input.value);
    }

    renderSiteRules(response.settings.siteRules);
    renderProviderState(currentProvider);
  }

  function showSaveStatus(message, error = false) {
    elements.saveStatus.textContent = message;
    elements.saveStatus.style.color = error ? "#a22e44" : "#176e51";
  }

  async function savePendingProviderKey(provider = currentProvider) {
    const apiKey = elements.apiKey.value.trim();

    if (!apiKey) {
      return false;
    }

    const response = await api.runtime.sendMessage({
      type: "updateProviderKey",
      action: "set",
      apiKey,
      provider,
      site: ""
    });
    providerStatuses = { ...response.providers };
    elements.apiKey.value = "";

    if (currentProvider === provider) {
      renderProviderState(provider);
    }

    return true;
  }

  async function loadModels(force = false) {
    const provider = currentProvider;
    await savePendingProviderKey(provider);
    const response = await api.runtime.sendMessage({
      type: "listProviderModels",
      force,
      provider
    });
    availableModels[provider] = response.models;

    if (currentProvider === provider) {
      renderModelOptions(provider);
      providerModels[provider] = elements.model.value;
    }

    return response.models;
  }

  async function load() {
    const response = await api.runtime.sendMessage({ type: "getSettings", site: "", includeCacheEntries: true });
    render(response);

    if (providerStatuses[currentProvider]?.hasApiKey) {
      await loadModels().catch((error) => showSaveStatus(String(error?.message || error), true));
    }
  }

  elements.provider.addEventListener("change", () => {
    providerModels[currentProvider] = elements.model.value || providerModels[currentProvider];
    currentProvider = elements.provider.value;
    elements.apiKey.value = "";
    renderProviderState(currentProvider);

    if (providerStatuses[currentProvider]?.hasApiKey && !availableModels[currentProvider]) {
      void loadModels().catch((error) => showSaveStatus(String(error?.message || error), true));
    }
  });

  elements.model.addEventListener("change", () => {
    providerModels[currentProvider] = elements.model.value;
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = event.submitter || elements.form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    showSaveStatus("Saving…");

    try {
      const provider = currentProvider;
      providerModels[provider] = elements.model.value;
      await savePendingProviderKey(provider);
      const response = await api.runtime.sendMessage({
        includeCacheEntries: true,
        type: "updateSettings",
        site: "",
        settings: {
          animationEnabled: elements.animationEnabled.checked,
          autoTranslateLanguages: elements.autoLanguageInputs.filter(({ checked }) => checked).map(({ value }) => value),
          cacheMaxEntries: Number(elements.cacheMaxEntries.value),
          provider,
          providerModels,
          siteRules: buildSiteRules(),
          sourceLanguage: elements.sourceLanguage.value,
          targetLanguage: elements.targetLanguage.value
        }
      });
      render(response);
      showSaveStatus("Settings saved.");
    } catch (error) {
      showSaveStatus(String(error?.message || error), true);
    } finally {
      submitButton.disabled = false;
    }
  });

  elements.refreshModelsButton.addEventListener("click", async () => {
    elements.refreshModelsButton.disabled = true;
    elements.refreshModelsButton.textContent = "Loading…";

    try {
      const provider = currentProvider;
      const models = await loadModels(true);
      showSaveStatus(`${models.length} compatible ${getProviderLabel(provider)} models loaded.`);
    } catch (error) {
      showSaveStatus(String(error?.message || error), true);
    } finally {
      elements.refreshModelsButton.disabled = false;
      elements.refreshModelsButton.textContent = "Load models";
    }
  });

  elements.testButton.addEventListener("click", async () => {
    elements.testButton.disabled = true;
    elements.testButton.textContent = "Testing…";

    try {
      const provider = currentProvider;
      const model = elements.model.value;
      await savePendingProviderKey(provider);
      providerModels[provider] = model;
      const response = await api.runtime.sendMessage({
        type: "testProviderConnection",
        model,
        provider
      });
      showSaveStatus(`${getProviderLabel(response.provider)} connection works. ${response.model} is available.`);
    } catch (error) {
      showSaveStatus(String(error?.message || error), true);
    } finally {
      elements.testButton.disabled = false;
      elements.testButton.textContent = "Test connection";
    }
  });

  elements.clearKeyButton.addEventListener("click", async () => {
    const provider = currentProvider;
    elements.clearKeyButton.disabled = true;

    try {
      const response = await api.runtime.sendMessage({
        type: "updateProviderKey",
        action: "clear",
        provider,
        site: ""
      });
      providerStatuses = { ...response.providers };

      if (currentProvider === provider) {
        renderProviderState(provider);
      }

      showSaveStatus(`${getProviderLabel(provider)} API key removed.`);
    } catch (error) {
      showSaveStatus(String(error?.message || error), true);
    } finally {
      renderProviderState(currentProvider);
    }
  });

  elements.clearCacheButton.addEventListener("click", async () => {
    elements.clearCacheButton.disabled = true;

    try {
      await api.runtime.sendMessage({ type: "clearCache" });
      elements.cacheCount.textContent = `0 phrases · 0.0 MiB / ${formatMiB(cacheMaximumBytes)}`;
      showSaveStatus("Translation cache cleared.");
    } catch (error) {
      showSaveStatus(String(error?.message || error), true);
    } finally {
      elements.clearCacheButton.disabled = false;
    }
  });

  load().catch((error) => showSaveStatus(String(error?.message || error), true));
})();
