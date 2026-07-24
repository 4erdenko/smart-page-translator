(function initializePopup() {
  const api = globalThis.browser;
  const elements = {
    apiItemCount: document.querySelector("#apiItemCount"),
    cacheEntries: document.querySelector("#cacheEntries"),
    cacheHitCount: document.querySelector("#cacheHitCount"),
    settingsButton: document.querySelector("#settingsButton"),
    siteLabel: document.querySelector("#siteLabel"),
    siteMode: document.querySelector("#siteMode"),
    statusBox: document.querySelector("#statusBox"),
    statusDetails: document.querySelector("#statusDetails"),
    statusTitle: document.querySelector("#statusTitle"),
    targetLanguage: document.querySelector("#targetLanguage"),
    translateButton: document.querySelector("#translateButton"),
    translatedCount: document.querySelector("#translatedCount")
  };
  let activeTab;
  let site = "";
  let privateTab = false;
  let apiConfigured = true;
  let providerLabel = "DeepSeek";
  const languageNames = {
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    it: "Italian",
    nl: "Dutch",
    pl: "Polish",
    pt: "Portuguese",
    ru: "Russian",
    uk: "Ukrainian"
  };

  function getSite(url) {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "";
    } catch {
      return "";
    }
  }

  function showStatus(title, details, tone = "idle") {
    elements.statusTitle.textContent = title;
    elements.statusDetails.textContent = details;
    elements.statusBox.dataset.tone = tone;
    document.body.dataset.tone = tone;
  }

  function renderPageStatus(status) {
    if (!apiConfigured) {
      showStatus("API key required", `Open Settings and configure a ${providerLabel} API key.`, "error");
      return;
    }

    if (!status) {
      showStatus("Page unavailable", "The browser does not allow extensions on this page.", "error");
      return;
    }

    elements.translatedCount.textContent = String(status.translatedElements || 0);
    elements.cacheHitCount.textContent = String(status.cacheHits || 0);
    elements.apiItemCount.textContent = String(status.apiItems || 0);

    elements.translateButton.disabled = !site;
    elements.translateButton.textContent = status.enabled ? "Scan page again" : "Translate this page";
    const language = languageNames[status.detectedLanguage] || status.detectedLanguage || "the page language";

    if (status.error) {
      showStatus("Translation stopped", status.error, "error");
    } else if (status.translating) {
      showStatus("Translation spreading", `${language} text is being processed in parallel.`, "working");
    } else if (status.enabled && status.translatedElements > 0) {
      const rule = status.activation === "language"
        ? `${language} matched your automatic rules.`
        : status.activation === "manual"
          ? "One-time translation is active for this page."
          : "This website is always translated.";
      showStatus("Page translated", `${rule} Dynamic content stays translated.`, "success");
    } else if (status.enabled) {
      showStatus("Watching this page", "Waiting for translatable text or a response.", "working");
    } else if (privateTab) {
      showStatus("Private tab", "Use one-time translation; page text will not be cached.", "idle");
    } else if (status.siteMode === "never") {
      showStatus("Translation disabled", "This website is on the never-translate list.", "idle");
    } else {
      showStatus("Waiting for a rule", `${language} is not selected for automatic translation.`, "idle");
    }
  }

  async function readPageStatus() {
    if (!activeTab?.id || !site) {
      return null;
    }

    try {
      return await api.tabs.sendMessage(activeTab.id, { type: "getStatus" }, { frameId: 0 });
    } catch {
      return null;
    }
  }

  async function refreshStatus() {
    const [status, cache] = await Promise.all([
      readPageStatus(),
      api.runtime.sendMessage({ type: "getCacheStats" }).catch(() => null)
    ]);
    renderPageStatus(status);

    if (Number.isFinite(cache?.cacheEntries)) {
      elements.cacheEntries.textContent = String(cache.cacheEntries);
    }
  }

  async function initialize() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
    site = getSite(activeTab?.url);
    privateTab = activeTab?.incognito === true;
    elements.siteLabel.textContent = site ? new URL(site).hostname || "Local file" : "Restricted page";
    elements.siteMode.disabled = !site || privateTab;
    elements.translateButton.disabled = !site;

    const response = await api.runtime.sendMessage({ type: "getSettings", site, includeCacheEntries: true });
    apiConfigured = response.hasApiKey;
    providerLabel = response.providers?.[response.settings.provider]?.label || response.settings.provider;
    elements.siteMode.value = response.siteMode || "auto";
    elements.targetLanguage.value = response.settings.targetLanguage;
    elements.cacheEntries.textContent = String(response.cacheEntries || 0);

    await refreshStatus();
  }

  elements.siteMode.addEventListener("change", async () => {
    if (privateTab) {
      return;
    }

    elements.siteMode.disabled = true;

    try {
      await api.runtime.sendMessage({
        type: "setSiteMode",
        site,
        tabId: activeTab.id,
        mode: elements.siteMode.value
      });
      await refreshStatus();
    } catch (error) {
      showStatus("Could not update website", String(error?.message || error), "error");
      await initialize().catch(() => undefined);
    } finally {
      elements.siteMode.disabled = !site || privateTab;
    }
  });

  elements.targetLanguage.addEventListener("change", async () => {
    try {
      await api.runtime.sendMessage({
        type: "updateSettings",
        site,
        settings: { targetLanguage: elements.targetLanguage.value }
      });
      await refreshStatus();
    } catch (error) {
      showStatus("Could not change language", String(error?.message || error), "error");
    }
  });

  elements.translateButton.addEventListener("click", async () => {
    try {
      const status = await api.tabs.sendMessage(activeTab.id, { type: "translateNow" }, { frameId: 0 });
      renderPageStatus(status);
    } catch {
      showStatus("Page unavailable", "Reload the page after installing the extension.", "error");
    }
  });

  elements.settingsButton.addEventListener("click", () => api.runtime.openOptionsPage());

  initialize().catch((error) => {
    showStatus("Extension error", String(error?.message || error), "error");
  });

  setInterval(refreshStatus, 800);
})();
