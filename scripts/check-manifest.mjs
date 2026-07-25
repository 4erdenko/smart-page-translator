import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getReleaseSourceFiles } from "./build.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";
const outputDirectory = path.join(projectRoot, "dist", target);
const manifest = JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
const backgroundFiles = manifest.background.scripts || [manifest.background.service_worker];
const actionIconFiles = typeof manifest.action.default_icon === "string"
  ? [manifest.action.default_icon]
  : Object.values(manifest.action.default_icon);
const referencedFiles = new Set([
  ...backgroundFiles,
  ...manifest.content_scripts.flatMap(({ js }) => js),
  manifest.action.default_popup,
  ...actionIconFiles,
  manifest.options_ui.page,
  ...Object.values(manifest.icons)
]);
const releaseNoticeFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "vendor/LICENSE.fontkit.txt",
  "vendor/LICENSE.pdf-lib.txt",
  "vendor/LICENSE.pdfjs.txt",
  "vendor/LICENSE.webextension-polyfill.txt"
];
const expectedPackageFiles = new Set([
  ...getReleaseSourceFiles(target),
  ...releaseNoticeFiles,
  "manifest.json",
  "vendor/browser-polyfill.js",
  "vendor/fontkit.js",
  "vendor/pdf-lib.js"
]);

async function listPackageFiles(directory, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listPackageFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Package contains an unsupported filesystem entry: ${relativePath}`);
    }
  }

  return files;
}

async function listMissingHtmlResources(packageFiles) {
  const missingResources = [];

  for (const htmlFile of [...packageFiles].filter((file) => file.endsWith(".html"))) {
    const html = await readFile(path.join(outputDirectory, htmlFile), "utf8");

    for (const [, resource] of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#]+)["']/giu)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(resource)) {
        continue;
      }

      const resourcePath = path.posix.normalize(path.posix.join(path.posix.dirname(htmlFile), resource));

      if (!packageFiles.has(resourcePath)) {
        missingResources.push(`${htmlFile} -> ${resourcePath}`);
      }
    }
  }

  return missingResources;
}

for (const file of [
  "vendor/pdf.mjs",
  "vendor/pdf.worker.mjs",
  ...await listPackageFiles(
    path.join(projectRoot, "node_modules", "pdfjs-dist", "cmaps"),
    "vendor/cmaps"
  ),
  ...await listPackageFiles(
    path.join(projectRoot, "node_modules", "pdfjs-dist", "standard_fonts"),
    "vendor/standard_fonts"
  ),
  ...await listPackageFiles(
    path.join(projectRoot, "node_modules", "pdfjs-dist", "wasm"),
    "vendor/wasm"
  )
]) {
  expectedPackageFiles.add(file);
}

if (manifest.manifest_version !== 3) {
  throw new Error("Expected Manifest V3.");
}

const expectedHostPermissions = [
  "https://api.deepseek.com/*",
  "https://api.openai.com/*"
];

if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHostPermissions)) {
  throw new Error("Host permissions must be limited to the supported provider APIs.");
}

if (!manifest.content_scripts?.some(({ matches }) => matches?.includes("<all_urls>"))) {
  throw new Error("Whole-page translation requires an all-URLs content script match.");
}

if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none'") {
  throw new Error("Extension pages must use the repository's restrictive Content Security Policy.");
}

if (target === "firefox") {
  if (!manifest.background.scripts || manifest.background.service_worker) {
    throw new Error("Firefox must use background.scripts.");
  }

  const disclosures = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required || [];

  if (!disclosures.includes("authenticationInfo") || !disclosures.includes("websiteContent")) {
    throw new Error("Firefox authenticationInfo or websiteContent data collection disclosure is missing.");
  }

  if (!/^\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}$/iu.test(
    manifest.browser_specific_settings?.gecko?.id || ""
  )) {
    throw new Error("Firefox signing requires a stable, non-personal extension ID.");
  }

  await access(path.join(outputDirectory, "service-worker.js")).then(
    () => {
      throw new Error("The Firefox package must not contain the unused Chrome service worker.");
    },
    () => undefined
  );
} else if (!manifest.background.service_worker || manifest.background.scripts) {
  throw new Error("Chrome must use a single background.service_worker.");
}

await Promise.all([...referencedFiles].map((file) => access(path.join(outputDirectory, file))));
await Promise.all(releaseNoticeFiles.map((file) => access(path.join(outputDirectory, file))));
const packageFiles = new Set(await listPackageFiles(outputDirectory));
const missingPackageFiles = [...expectedPackageFiles].filter((file) => !packageFiles.has(file));
const unexpectedPackageFiles = [...packageFiles].filter((file) => !expectedPackageFiles.has(file));
const missingHtmlResources = await listMissingHtmlResources(packageFiles);

if (missingPackageFiles.length || unexpectedPackageFiles.length || missingHtmlResources.length) {
  throw new Error(
    `Package allowlist mismatch. Missing: ${missingPackageFiles.join(", ") || "none"}. `
    + `Unexpected: ${unexpectedPackageFiles.join(", ") || "none"}. `
    + `Missing HTML resources: ${missingHtmlResources.join(", ") || "none"}.`
  );
}

const [sourceLicense, packagedLicense] = await Promise.all([
  readFile(path.join(projectRoot, "LICENSE"), "utf8"),
  readFile(path.join(outputDirectory, "LICENSE"), "utf8")
]);

if (sourceLicense !== packagedLicense) {
  throw new Error("The packaged project license must match the repository license.");
}

console.log(
  `${target} manifest check passed with ${referencedFiles.size} referenced files and release notices.`
);
