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
