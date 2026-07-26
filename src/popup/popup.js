(function initializePopup() {
  const api = globalThis.browser;
  const {
    fillLanguageSelect,
    getLanguageName,
    localizeDocument,
    t
  } = globalThis.SmartTranslationUiI18n;
  localizeDocument();
  const elements = {
    apiItemCount: document.querySelector("#apiItemCount"),
    cacheHitCount: document.querySelector("#cacheHitCount"),
    cacheSummary: document.querySelector("#cacheSummary"),
    pdfButton: document.querySelector("#pdfButton"),
    settingsButton: document.querySelector("#settingsButton"),
    siteLabel: document.querySelector("#siteLabel"),
    siteMode: document.querySelector("#siteMode"),
    siteViewMode: document.querySelector("#siteViewMode"),
    statusBox: document.querySelector("#statusBox"),
    statusDetails: document.querySelector("#statusDetails"),
    statusTitle: document.querySelector("#statusTitle"),
    targetLanguage: document.querySelector("#targetLanguage"),
    translateButton: document.querySelector("#translateButton"),
    translatedCount: document.querySelector("#translatedCount"),
    viewModeButtons: [...document.querySelectorAll("[data-view-mode]")],
    viewModes: document.querySelector("#viewModes")
  };
  fillLanguageSelect(elements.targetLanguage);
  let activeTab;
  let site = "";
  let privateTab = false;
  let apiConfigured = true;
  let providerLabel = "DeepSeek";

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

  function updateCacheSummary(value) {
    elements.cacheSummary.textContent = t(
      "translationsSavedLocally",
      { count: Number(value) || 0 },
      `${Number(value) || 0} translations saved locally`
    );
  }

  function updateActions(status) {
    const canChangeView = Boolean(status?.enabled)
      && (status?.translatedElements > 0 || status?.viewMode === "original");
    elements.viewModes.hidden = !canChangeView;

    for (const button of elements.viewModeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.viewMode === status?.viewMode));
    }

    elements.translateButton.hidden = Boolean(status?.enabled && !status?.error);
    elements.translateButton.disabled = !site || !apiConfigured;
    elements.translateButton.textContent = status?.error
      ? t("retryTranslation", null, "Retry translation")
      : t("translateThisPage", null, "Translate this page");
  }

  function renderPageStatus(status) {
    elements.translatedCount.textContent = String(status?.translatedElements || 0);
    elements.cacheHitCount.textContent = String(status?.cacheHits || 0);
    elements.apiItemCount.textContent = String(status?.apiItems || 0);

    if (Number.isFinite(status?.cacheEntries)) {
      updateCacheSummary(status.cacheEntries);
    }

    updateActions(status);

    if (!apiConfigured) {
      showStatus(
        t("apiKeyRequired", null, "API key required"),
        t(
          "apiKeyRequiredDetails",
          { provider: providerLabel },
          `Open Settings and configure a ${providerLabel} API key.`
        ),
        "error"
      );
      return;
    }

    if (!status) {
      showStatus(
        t("pageUnavailable", null, "Page unavailable"),
        t("pageUnavailableDetails", null, "The browser does not allow extensions on this page."),
        "error"
      );
      return;
    }

    const language = status.detectedLanguage
      ? getLanguageName(status.detectedLanguage)
      : t("pageLanguage", null, "the page language");

    if (status.error) {
      showStatus(t("translationStopped", null, "Translation stopped"), status.error, "error");
    } else if (status.translating) {
      showStatus(
        t("translationSpreading", null, "Translation spreading"),
        t(
          "translationSpreadingDetails",
          { language },
          `${language} text is being processed in parallel.`
        ),
        "working"
      );
    } else if (status.viewMode === "original") {
      showStatus(
        t("showingOriginal", null, "Showing original"),
        t(
          "showingOriginalDetails",
          null,
          "Translation remains ready and can be restored from the local cache."
        ),
        "idle"
      );
    } else if (status.viewMode === "bilingual" && status.enabled && status.translatedElements > 0) {
      showStatus(
        t("bilingualViewActive", null, "Bilingual view"),
        t(
          "bilingualViewDetails",
          null,
          "Original and translated page text are shown together."
        ),
        "success"
      );
    } else if (status.enabled && status.translatedElements > 0) {
      const rule = status.activation === "language"
        ? t("automaticRuleMatched", { language }, `${language} matched your automatic rules.`)
        : status.activation === "manual"
          ? t("manualTranslationActive", null, "One-time translation is active for this page.")
          : t("siteAlwaysTranslated", null, "This website is always translated.");
      showStatus(
        t("pageTranslated", null, "Page translated"),
        `${rule} ${t("dynamicContentTranslated", null, "Dynamic content stays translated.")}`,
        "success"
      );
    } else if (status.enabled) {
      showStatus(
        t("watchingPage", null, "Watching this page"),
        t("watchingPageDetails", null, "Waiting for translatable text or a response."),
        "working"
      );
    } else if (privateTab) {
      showStatus(
        t("privateTab", null, "Private tab"),
        t("privateTabDetails", null, "Use one-time translation; page text will not be cached."),
        "idle"
      );
    } else if (status.siteMode === "never") {
      showStatus(
        t("translationDisabled", null, "Translation disabled"),
        t("neverTranslateDetails", null, "This website is on the never-translate list."),
        "idle"
      );
    } else {
      showStatus(
        t("waitingForRule", null, "Waiting for a rule"),
        t(
          "waitingForRuleDetails",
          { language },
          `${language} is not selected for automatic translation.`
        ),
        "idle"
      );
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
      updateCacheSummary(cache.cacheEntries);
    }
  }

  async function initialize() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
    site = getSite(activeTab?.url);
    privateTab = activeTab?.incognito === true;
    elements.siteLabel.textContent = site
      ? new URL(site).hostname || t("localFile", null, "Local file")
      : t("restrictedPage", null, "Restricted page");
    elements.siteMode.disabled = !site || privateTab;
    elements.siteViewMode.disabled = !site || privateTab;
    elements.translateButton.disabled = !site;

    const response = await api.runtime.sendMessage({ type: "getSettings", site, includeCacheEntries: true });
    apiConfigured = response.hasApiKey;
    providerLabel = response.providers?.[response.settings.provider]?.label || response.settings.provider;
    elements.siteMode.value = response.siteMode || "auto";
    elements.siteViewMode.value = response.siteViewMode || "default";
    elements.siteViewMode.querySelector('[value="default"]').textContent = t(
      "followDefaultView",
      {
        view: response.settings.defaultViewMode === "bilingual"
          ? t("viewBilingual", null, "Bilingual")
          : t("viewTranslated", null, "Translated")
      },
      `Follow default (${response.settings.defaultViewMode === "bilingual" ? "Bilingual" : "Translated"})`
    );
    elements.targetLanguage.value = response.settings.targetLanguage;
    updateCacheSummary(response.cacheEntries);

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
      showStatus(
        t("couldNotUpdateWebsite", null, "Could not update website"),
        String(error?.message || error),
        "error"
      );
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
      showStatus(
        t("couldNotChangeLanguage", null, "Could not change language"),
        String(error?.message || error),
        "error"
      );
    }
  });

  elements.siteViewMode.addEventListener("change", async () => {
    if (privateTab) {
      return;
    }

    elements.siteViewMode.disabled = true;

    try {
      await api.runtime.sendMessage({
        type: "setSiteViewMode",
        site,
        tabId: activeTab.id,
        viewMode: elements.siteViewMode.value
      });
    } catch (error) {
      showStatus(
        t("couldNotUpdateWebsite", null, "Could not update website"),
        String(error?.message || error),
        "error"
      );
      await initialize().catch(() => undefined);
    } finally {
      elements.siteViewMode.disabled = !site || privateTab;
    }
  });

  elements.translateButton.addEventListener("click", async () => {
    try {
      const status = await api.tabs.sendMessage(activeTab.id, { type: "translateNow" }, { frameId: 0 });
      renderPageStatus(status);
    } catch {
      showStatus(
        t("pageUnavailable", null, "Page unavailable"),
        t("reloadAfterInstall", null, "Reload the page after installing the extension."),
        "error"
      );
    }
  });

  for (const button of elements.viewModeButtons) {
    button.addEventListener("click", async () => {
      const type = {
        bilingual: "showBilingual",
        original: "showOriginal",
        translated: "showTranslation"
      }[button.dataset.viewMode];

      try {
        const status = await api.tabs.sendMessage(activeTab.id, { type }, { frameId: 0 });
        renderPageStatus(status);
      } catch {
        showStatus(
          t("pageUnavailable", null, "Page unavailable"),
          t("reloadAfterInstall", null, "Reload the page after installing the extension."),
          "error"
        );
      }
    });
  }

  elements.pdfButton.addEventListener("click", () => {
    void api.tabs.create({ url: api.runtime.getURL("pdf/pdf.html") });
    window.close();
  });

  elements.settingsButton.addEventListener("click", () => api.runtime.openOptionsPage());

  function handleStatusMessage(message, sender) {
    if (message?.type === "translationStatus"
      && sender.tab?.id === activeTab?.id
      && sender.frameId === 0) {
      renderPageStatus(message.status);
    }
  }

  api.runtime.onMessage.addListener(handleStatusMessage);
  window.addEventListener("unload", () => api.runtime.onMessage.removeListener(handleStatusMessage), { once: true });

  initialize().catch((error) => {
    showStatus(
      t("extensionError", null, "Extension error"),
      String(error?.message || error),
      "error"
    );
  });
})();
