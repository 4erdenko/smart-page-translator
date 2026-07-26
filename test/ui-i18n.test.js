const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
  LANGUAGE_CODES,
  formatMessage,
  t
} = require("../src/lib/ui-i18n.js");
const manifest = require("../manifests/base.json");
const englishMessages = require("../src/_locales/en/messages.json");
const russianMessages = require("../src/_locales/ru/messages.json");

test("formats localized UI messages without evaluating page text", () => {
  assert.equal(
    formatMessage("{language} → {target}", {
      language: "Portuguese",
      target: "Russian"
    }),
    "Portuguese → Russian"
  );
  assert.equal(formatMessage("{missing}", {}), "{missing}");
});

test("falls back to English UI copy when a locale message is unavailable", () => {
  assert.equal(t("missingMessage", null, "Fallback text"), "Fallback text");
  assert.deepEqual(LANGUAGE_CODES, [
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
});

test("onboarding blocks navigation actions while checking a provider", () => {
  const source = readFileSync(require.resolve("../src/onboarding/onboarding.js"), "utf8");
  const handlerStart = source.indexOf("function setBusy(busy)");
  const handlerEnd = source.indexOf("async function load()", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(handler, /elements\.settingsButton\.disabled = busy;/u);
  assert.match(handler, /elements\.skipButton\.disabled = busy;/u);
});

test("onboarding waits for saved settings before enabling setup", () => {
  const html = readFileSync(require.resolve("../src/onboarding/onboarding.html"), "utf8");
  const source = readFileSync(require.resolve("../src/onboarding/onboarding.js"), "utf8");

  assert.match(html, /id="apiKey"[^>]* disabled>/u);
  assert.match(html, /id="targetLanguage" disabled>/u);
  assert.match(html, /id="startButton"[^>]* disabled>/u);
  assert.match(source, /let setupReady = false;/u);
  assert.match(source, /const setupDisabled = busy \|\| !setupReady;/u);
  assert.match(source, /const commandsPromise = api\.commands\.getAll\(\)\.catch\(\(\) => \[\]\);/u);
  assert.match(source, /setupReady = true;\s+setBusy\(false\);/u);
  assert.match(source, /if \(!setupReady\) \{\s+return;\s+\}/u);
  assert.match(source, /load\(\)\.catch\(\(error\) => \{\s+setBusy\(false\);\s+showStatus/u);
});

test("keeps shipped locales complete and covers referenced UI messages", () => {
  assert.equal(manifest.action.default_title, "__MSG_extensionName__");
  assert.deepEqual(
    Object.keys(russianMessages).sort(),
    Object.keys(englishMessages).sort()
  );
  const sourceFiles = [
    "../manifests/base.json",
    "../src/background.js",
    "../src/content.js",
    "../src/onboarding/onboarding.html",
    "../src/onboarding/onboarding.js",
    "../src/options/options.html",
    "../src/options/options.js",
    "../src/popup/popup.html",
    "../src/popup/popup.js"
  ];
  const source = sourceFiles
    .map((file) => readFileSync(require.resolve(file), "utf8"))
    .join("\n");
  const referencedKeys = new Set([
    ...[...source.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/gu)]
      .map((match) => match[1]),
    ...[...source.matchAll(/\bt\("([^"]+)"/gu)].map((match) => match[1]),
    ...[...source.matchAll(/__MSG_([a-zA-Z0-9_]+)__/gu)].map((match) => match[1]),
    "contextTranslateSelection"
  ]);

  assert.deepEqual(
    [...referencedKeys].filter((key) => !englishMessages[key]),
    []
  );
});
