import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";

if (!["chrome", "firefox"].includes(target)) {
  throw new Error("Build target must be firefox or chrome.");
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

const sourceDirectory = path.join(projectRoot, "src");
const distributionDirectory = path.join(projectRoot, "dist");
const outputDirectory = path.join(distributionDirectory, target);
const manifestDirectory = path.join(projectRoot, "manifests");
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
await mkdir(path.join(outputDirectory, "vendor"), { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });
await cp(
  path.join(projectRoot, "node_modules", "webextension-polyfill", "dist", "browser-polyfill.min.js"),
  path.join(outputDirectory, "vendor", "browser-polyfill.js")
);
await cp(
  path.join(projectRoot, "node_modules", "webextension-polyfill", "LICENSE"),
  path.join(outputDirectory, "vendor", "LICENSE.webextension-polyfill.txt")
);
await cp(
  path.join(projectRoot, "LICENSE"),
  path.join(outputDirectory, "LICENSE")
);
await cp(
  path.join(projectRoot, "THIRD_PARTY_NOTICES.md"),
  path.join(outputDirectory, "THIRD_PARTY_NOTICES.md")
);

if (target === "firefox") {
  await rm(path.join(outputDirectory, "service-worker.js"));
}

const manifest = mergeManifest(baseManifest, targetManifest);
manifest.version = packageManifest.version;
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(`Built ${target} extension in ${outputDirectory}`);
