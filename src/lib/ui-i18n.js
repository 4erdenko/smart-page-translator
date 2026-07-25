(function initializeUiI18n(root, factory) {
  const api = factory(root.browser);
  root.SmartTranslationUiI18n = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis, function createUiI18n(browserApi) {
  const LANGUAGE_CODES = Object.freeze([
    "en",
    "pt",
    "es",
    "fr",
    "de",
    "it",
    "nl",
    "uk",
    "pl",
    "ru"
  ]);

  function formatMessage(value, replacements) {
    const values = replacements && typeof replacements === "object" ? replacements : {};
    return String(value).replace(/\{([a-z][a-z0-9]*)\}/giu, (match, key) => (
      Object.hasOwn(values, key) ? String(values[key]) : match
    ));
  }

  function t(key, replacements, fallback = "") {
    const translated = browserApi?.i18n?.getMessage?.(key);
    return formatMessage(translated || fallback || key, replacements);
  }

  function getLanguageName(code) {
    try {
      const locale = browserApi?.i18n?.getUILanguage?.() || "en";
      return new Intl.DisplayNames([locale], { type: "language" }).of(code) || code;
    } catch {
      return code;
    }
  }

  function fillLanguageSelect(select, { includeAuto = false } = {}) {
    if (!select) {
      return;
    }

    const options = [];

    if (includeAuto) {
      const option = document.createElement("option");
      option.value = "auto";
      option.textContent = t("detectAutomatically", null, "Detect automatically");
      options.push(option);
    }

    for (const code of LANGUAGE_CODES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = getLanguageName(code);
      options.push(option);
    }

    select.replaceChildren(...options);
  }

  function fillLanguageChoices(container) {
    if (!container) {
      return;
    }

    container.replaceChildren(...LANGUAGE_CODES.map((code) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const name = document.createElement("span");
      input.type = "checkbox";
      input.name = "autoTranslateLanguage";
      input.value = code;
      name.textContent = getLanguageName(code);
      label.append(input, name);
      return label;
    }));
  }

  function localizeDocument(root = document) {
    const locale = browserApi?.i18n?.getUILanguage?.();

    if (locale && root.documentElement) {
      root.documentElement.lang = locale;
    }

    for (const element of root.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n, null, element.textContent);
    }

    for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
      element.setAttribute(
        "placeholder",
        t(element.dataset.i18nPlaceholder, null, element.getAttribute("placeholder"))
      );
    }

    for (const element of root.querySelectorAll("[data-i18n-title]")) {
      element.setAttribute("title", t(element.dataset.i18nTitle, null, element.getAttribute("title")));
    }

    for (const element of root.querySelectorAll("[data-i18n-aria-label]")) {
      element.setAttribute(
        "aria-label",
        t(element.dataset.i18nAriaLabel, null, element.getAttribute("aria-label"))
      );
    }
  }

  return Object.freeze({
    LANGUAGE_CODES,
    fillLanguageChoices,
    fillLanguageSelect,
    formatMessage,
    getLanguageName,
    localizeDocument,
    t
  });
});
