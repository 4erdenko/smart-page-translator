import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} does not reference the current release metadata: ${expected}`);
  }
}

const [
  packageManifest,
  packageLock,
  baseManifest,
  changelog,
  listingEnglish,
  listingRussian,
  reviewerNotes
] = await Promise.all([
  readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "package-lock.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "manifests", "base.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "CHANGELOG.md"), "utf8"),
  readFile(path.join(projectRoot, "docs", "store", "listing-en.md"), "utf8"),
  readFile(path.join(projectRoot, "docs", "store", "listing-ru.md"), "utf8"),
  readFile(path.join(projectRoot, "docs", "store", "reviewer-notes.md"), "utf8")
]);
const version = packageManifest.version;
const releaseTag = `v${version}`;

if (packageLock.version !== version
  || packageLock.packages?.[""]?.version !== version
  || baseManifest.version !== version) {
  throw new Error("package.json, package-lock.json, and manifests/base.json versions must match.");
}

requireText(changelog, `## ${version} - `, "CHANGELOG.md");
requireText(listingEnglish, `## Version ${version} notes`, "English store listing");
requireText(listingEnglish, `/tree/${releaseTag}`, "English store listing");
requireText(listingRussian, `## Что нового в версии ${version}`, "Russian store listing");
requireText(listingRussian, `/tree/${releaseTag}`, "Russian store listing");
requireText(reviewerNotes, `Version: ${version}`, "Reviewer notes");
requireText(reviewerNotes, `tag \`${releaseTag}\``, "Reviewer notes");

console.log(`Release metadata check passed for ${releaseTag}.`);
