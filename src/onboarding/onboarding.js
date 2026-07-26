(function initializeOnboarding() {
  const api = globalThis.browser;
  const { PROVIDERS } = globalThis.SmartTranslationProviderCore;
  const {
    fillLanguageSelect,
    localizeDocument,
    t
  } = globalThis.SmartTranslationUiI18n;
  localizeDocument();
  const elements = {
    apiKey: document.querySelector("#apiKey"),
    apiKeyLink: document.querySelector("#apiKeyLink"),
    cycleShortcut: document.querySelector("#cycleShortcut"),
    editableShortcut: document.querySelector("#editableShortcut"),
    form: document.querySelector("#setupForm"),
    keyHint: document.querySelector("#keyHint"),
    providerInputs: [...document.querySelectorAll('input[name="provider"]')],
    settingsButton: document.querySelector("#settingsButton"),
    skipButton: document.querySelector("#skipButton"),
    startButton: document.querySelector("#startButton"),
    status: document.querySelector("#status"),
    targetLanguage: document.querySelector("#targetLanguage"),
    toggleShortcut: document.querySelector("#toggleShortcut")
  };
  let providerStatuses = {};
  let setupComplete = false;
  let setupReady = false;
  fillLanguageSelect(elements.targetLanguage);

  function getSelectedProvider() {
    return elements.providerInputs.find(({ checked }) => checked)?.value || "deepseek";
  }

  function getProviderLabel(provider) {
    return providerStatuses[provider]?.label || PROVIDERS[provider].label;
  }

  function showStatus(message, state = "") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
  }

  function resetCompletion() {
    setupComplete = false;
    elements.startButton.textContent = t("checkKeyAndStart", null, "Check key and start");
    showStatus("");
  }

  function renderProvider() {
    const provider = getSelectedProvider();
    const label = getProviderLabel(provider);
    const configured = Boolean(providerStatuses[provider]?.hasApiKey);
    for (const input of elements.providerInputs) {
      input.closest(".provider-card").classList.toggle("selected", input.checked);
    }
    elements.apiKey.value = "";
    elements.apiKeyLink.href = PROVIDERS[provider].apiKeyUrl;
    elements.apiKeyLink.querySelector("span").textContent = t(
      "createProviderApiKey",
      { provider: label },
      `Create ${label} API key`
    );
    elements.apiKey.placeholder = configured
      ? t("replaceApiKeyPlaceholder", null, "Leave blank to use the saved key")
      : t("pasteApiKeyPlaceholder", null, "Paste your key here");
    elements.keyHint.textContent = configured
      ? t(
        "onboardingKeyConfigured",
        { provider: label },
        `${label} is already connected. Leave this field blank to verify the saved key.`
      )
      : t(
        "onboardingKeyHint",
        null,
        "The key is saved only after the connection succeeds."
      );
    resetCompletion();
  }

  function renderShortcut(element, shortcut) {
    if (!shortcut) {
      const label = document.createElement("span");
      label.className = "shortcut-unassigned";
      label.textContent = t("shortcutUnassigned", null, "Set in browser");
      element.replaceChildren(label);
      return;
    }

    element.replaceChildren(...shortcut.split("+").map((part) => {
      const key = document.createElement("kbd");
      key.textContent = {
        Command: "⌘",
        MacCtrl: "Ctrl",
        Option: "⌥"
      }[part] || part;
      return key;
    }));
  }

  function setBusy(busy) {
    const setupDisabled = busy || !setupReady;
    elements.apiKey.disabled = setupDisabled;
    elements.settingsButton.disabled = busy;
    elements.skipButton.disabled = busy;
    elements.startButton.disabled = setupDisabled;
    elements.targetLanguage.disabled = setupDisabled;

    for (const input of elements.providerInputs) {
      input.disabled = setupDisabled;
    }

    elements.startButton.textContent = busy
      ? t("checkingConnection", null, "Checking connection…")
      : t("checkKeyAndStart", null, "Check key and start");
  }

  async function load() {
    const commandsPromise = api.commands.getAll().catch(() => []);
    const response = await api.runtime.sendMessage({ type: "getSettings" });
    providerStatuses = { ...response.providers };
    const currentProvider = response.settings.provider;
    const providerInput = elements.providerInputs.find(({ value }) => value === currentProvider);

    if (providerInput) {
      providerInput.checked = true;
    }

    elements.targetLanguage.value = response.settings.targetLanguage;
    renderProvider();
    setupReady = true;
    setBusy(false);
    const commands = await commandsPromise;
    const shortcuts = new Map(commands.map(({ name, shortcut }) => [name, shortcut]));
    renderShortcut(elements.toggleShortcut, shortcuts.get("toggle-translation"));
    renderShortcut(elements.cycleShortcut, shortcuts.get("cycle-view-mode"));
    renderShortcut(elements.editableShortcut, shortcuts.get("translate-editable"));
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!setupReady) {
      return;
    }

    if (setupComplete) {
      window.close();
      return;
    }

    const provider = getSelectedProvider();
    const label = getProviderLabel(provider);
    const apiKey = elements.apiKey.value.trim();

    if (!apiKey && !providerStatuses[provider]?.hasApiKey) {
      showStatus(
        t("pasteKeyBeforeContinuing", { provider: label }, `Paste a ${label} API key before continuing.`),
        "error"
      );
      elements.apiKey.focus();
      return;
    }

    setBusy(true);
    showStatus(t("checkingProviderConnection", { provider: label }, `Checking ${label}…`), "working");

    try {
      const response = await api.runtime.sendMessage({
        type: "configureProvider",
        apiKey,
        provider,
        targetLanguage: elements.targetLanguage.value
      });
      providerStatuses[provider] = {
        hasApiKey: true,
        label
      };
      elements.apiKey.value = "";
      elements.keyHint.textContent = t(
        "onboardingKeyStored",
        { provider: label },
        `The ${label} key is stored locally and is never displayed again.`
      );
      setupComplete = true;
      showStatus(
        t(
          "setupReady",
          { model: response.model, provider: label },
          `${label} is connected with ${response.model}. Translation is ready.`
        ),
        "success"
      );
      elements.startButton.textContent = t("done", null, "Done");
    } catch (error) {
      showStatus(
        t(
          "setupFailed",
          { message: String(error?.message || error) },
          `Could not connect. ${String(error?.message || error)}`
        ),
        "error"
      );
    } finally {
      setBusy(false);
      elements.startButton.textContent = setupComplete
        ? t("done", null, "Done")
        : t("checkKeyAndStart", null, "Check key and start");
    }
  });

  for (const input of elements.providerInputs) {
    input.addEventListener("change", renderProvider);
  }

  elements.apiKey.addEventListener("input", resetCompletion);
  elements.targetLanguage.addEventListener("change", resetCompletion);
  elements.settingsButton.addEventListener("click", () => api.runtime.openOptionsPage());
  elements.skipButton.addEventListener("click", () => window.close());

  setBusy(false);
  load().catch((error) => {
    setBusy(false);
    showStatus(String(error?.message || error), "error");
  });
})();
