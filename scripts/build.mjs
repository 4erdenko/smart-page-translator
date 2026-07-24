import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const sharedSourceFiles = Object.freeze([
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "assets/icon-96.png",
  "assets/icon-128.png",
  "assets/icon.svg",
  "background.js",
  "content.js",
  "lib/dom-core.js",
  "lib/provider-core.js",
  "lib/translation-core.js",
  "options/options.css",
  "options/options.html",
  "options/options.js",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js"
]);

export function getReleaseSourceFiles(target) {
  if (!["chrome", "firefox"].includes(target)) {
    throw new Error("Build target must be firefox or chrome.");
  }

  return target === "chrome"
    ? [...sharedSourceFiles, "service-worker.js"]
    : [...sharedSourceFiles];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeManifest(base, overlay) {
  const merged = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = isObject(value) && isObject(base[key])
      ? mergeManifest(base[key], value)
      : value;
  }

  return merged;
}

export async function buildTarget(target) {
  const sourceDirectory = path.join(projectRoot, "src");
  const distributionDirectory = path.join(projectRoot, "dist");
  const outputDirectory = path.join(distributionDirectory, target);
  const manifestDirectory = path.join(projectRoot, "manifests");
  const sourceFiles = getReleaseSourceFiles(target);
  const [baseManifest, targetManifest] = await Promise.all([
    readFile(path.join(manifestDirectory, "base.json"), "utf8").then(JSON.parse),
    readFile(path.join(manifestDirectory, `${target}.json`), "utf8").then(JSON.parse)
  ]);
  const packageManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  await mkdir(distributionDirectory, { recursive: true });
  const legacyBuildEntries = (await readdir(distributionDirectory, { withFileTypes: true }))
    .filter(({ name }) => !["chrome", "firefox"].includes(name));
  await Promise.all(legacyBuildEntries.map(({ name }) => rm(
    path.join(distributionDirectory, name),
    { recursive: true, force: true }
  )));
  await rm(outputDirectory, { recursive: true, force: true });
  await Promise.all(sourceFiles.map(async (relativePath) => {
    const destinationPath = path.join(outputDirectory, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(path.join(sourceDirectory, relativePath), destinationPath);
  }));
  await mkdir(path.join(outputDirectory, "vendor"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "node_modules", "webextension-polyfill", "dist", "browser-polyfill.min.js"),
    path.join(outputDirectory, "vendor", "browser-polyfill.js")
  );
  await copyFile(
    path.join(projectRoot, "node_modules", "webextension-polyfill", "LICENSE"),
    path.join(outputDirectory, "vendor", "LICENSE.webextension-polyfill.txt")
  );
  await copyFile(
    path.join(projectRoot, "LICENSE"),
    path.join(outputDirectory, "LICENSE")
  );
  await copyFile(
    path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(outputDirectory, "THIRD_PARTY_NOTICES.md")
  );

  const manifest = mergeManifest(baseManifest, targetManifest);
  manifest.version = packageManifest.version;
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(`Built ${target} extension in ${outputDirectory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";
  await buildTarget(target);
}
