const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const englishMessages = require("../src/_locales/en/messages.json");
const russianMessages = require("../src/_locales/ru/messages.json");
const { formatMessage } = require("../src/lib/ui-i18n.js");

function loadController(sourceFile, globalName) {
  const context = {};
  vm.runInNewContext(readFileSync(require.resolve(sourceFile), "utf8"), context);
  return context[globalName];
}

function localize(messages, presentation) {
  return {
    details: formatMessage(
      messages[presentation.detailsKey]?.message || presentation.detailsFallback
    ),
    title: formatMessage(
      messages[presentation.titleKey]?.message || presentation.titleFallback,
      presentation.titleReplacements
    )
  };
}

test("popup controller explains the detected language with an actionable next step", () => {
  const controller = loadController(
    "../src/popup/popup.js",
    "SmartTranslationPopupController"
  );
  const presentation = controller.getInactiveTranslationPresentation(
    { detectedLanguage: "pt" },
    "Portuguese",
    "ru",
    ["en", "pt", "ru"]
  );

  assert.deepEqual(localize(englishMessages, presentation), {
    details: "Translate now, always translate this website, or enable this language in Settings.",
    title: "Detected language: Portuguese"
  });
  assert.deepEqual(localize(russianMessages, {
    ...presentation,
    titleReplacements: { language: "португальский" }
  }), {
    details: "Переведите сейчас, включите перевод для этого сайта или добавьте язык в настройках.",
    title: "Определён язык: португальский"
  });
});

test("popup controller does not offer unavailable automatic language rules", () => {
  const controller = loadController(
    "../src/popup/popup.js",
    "SmartTranslationPopupController"
  );
  const unsupported = controller.getInactiveTranslationPresentation(
    { detectedLanguage: "zh" },
    "Chinese",
    "ru",
    ["en", "pt", "ru"]
  );
  const alreadyTarget = controller.getInactiveTranslationPresentation(
    { detectedLanguage: "pt-PT" },
    "Portuguese",
    "pt",
    ["en", "pt", "ru"]
  );

  assert.deepEqual(localize(englishMessages, unsupported), {
    details: "Translate this page now or always translate this website.",
    title: "Detected language: Chinese"
  });
  assert.deepEqual(localize(englishMessages, alreadyTarget), {
    details: "This page already uses your target language. Choose a different target language to translate it.",
    title: "Detected language: Portuguese"
  });
});

test("settings controller requires consent for new and replacement provider keys", () => {
  const controller = loadController(
    "../src/options/options.js",
    "SmartTranslationOptionsController"
  );

  assert.equal(controller.requiresProviderConsent("new-key", false), true);
  assert.equal(controller.requiresProviderConsent("new-key", true), false);
  assert.equal(controller.requiresProviderConsent("replacement-key", false), true);
  assert.equal(controller.requiresProviderConsent("", false), false);
});

test("settings sends the current provider consent contract with any entered key", () => {
  const source = readFileSync(require.resolve("../src/options/options.js"), "utf8");

  assert.match(source, /const hasCandidateKey = Boolean\(elements\.apiKey\.value\.trim\(\)\);/u);
  assert.match(source, /const visible = !configured \|\| hasCandidateKey;/u);
  assert.match(source, /elements\.apiKey\.addEventListener\("input", \(\) => \{\s+renderProviderConsent\(\);/u);
  assert.match(source, /providerDataConsent:\s*true/u);
  assert.match(source, /providerDataConsentVersion:\s*1/u);
});
