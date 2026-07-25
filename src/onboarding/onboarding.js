(function initializeOnboarding() {
  const api = globalThis.browser;
  const {
    fillLanguageSelect,
    localizeDocument,
    t
  } = globalThis.SmartTranslationUiI18n;
  localizeDocument();
  const elements = {
    cycleShortcut: document.querySelector("#cycleShortcut"),
    doneButton: document.querySelector("#doneButton"),
    editableShortcut: document.querySelector("#editableShortcut"),
    pdfButton: document.querySelector("#pdfButton"),
    settingsButton: document.querySelector("#settingsButton"),
    status: document.querySelector("#status"),
    targetLanguage: document.querySelector("#targetLanguage"),
    toggleShortcut: document.querySelector("#toggleShortcut")
  };
  fillLanguageSelect(elements.targetLanguage);

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

  async function load() {
    const [response, commands] = await Promise.all([
      api.runtime.sendMessage({ type: "getSettings" }),
      api.commands.getAll()
    ]);
    elements.targetLanguage.value = response.settings.targetLanguage;
    const shortcuts = new Map(commands.map(({ name, shortcut }) => [name, shortcut]));
    renderShortcut(elements.toggleShortcut, shortcuts.get("toggle-translation"));
    renderShortcut(elements.cycleShortcut, shortcuts.get("cycle-view-mode"));
    renderShortcut(elements.editableShortcut, shortcuts.get("translate-editable"));
  }

  elements.targetLanguage.addEventListener("change", async () => {
    elements.targetLanguage.disabled = true;

    try {
      await api.runtime.sendMessage({
        type: "updateSettings",
        settings: { targetLanguage: elements.targetLanguage.value }
      });
      elements.status.textContent = t("languageSaved", null, "Language saved.");
    } catch (error) {
      elements.status.textContent = String(error?.message || error);
    } finally {
      elements.targetLanguage.disabled = false;
    }
  });

  elements.pdfButton.addEventListener("click", () => {
    void api.tabs.create({ url: api.runtime.getURL("pdf/pdf.html") });
  });
  elements.settingsButton.addEventListener("click", () => api.runtime.openOptionsPage());
  elements.doneButton.addEventListener("click", () => window.close());

  load().catch((error) => {
    elements.status.textContent = String(error?.message || error);
  });
})();
