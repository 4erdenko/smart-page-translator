import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const allowedRuntimeDependencies = Object.freeze([
  "dejavu-fonts-ttf",
  "fontkit",
  "pdf-lib",
  "pdfjs-dist",
  "webextension-polyfill"
]);
const [packageManifest, packageLock] = await Promise.all([
  readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "package-lock.json"), "utf8").then(JSON.parse)
]);
const runtimeDependencies = Object.keys(packageManifest.dependencies || {}).sort();

if (JSON.stringify(runtimeDependencies) !== JSON.stringify(allowedRuntimeDependencies)) {
  throw new Error(`Unexpected direct runtime dependencies: ${runtimeDependencies.join(", ") || "none"}.`);
}

for (const [name, version] of Object.entries(packageManifest.dependencies)) {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(version)) {
    throw new Error(`Runtime dependency ${name} must use an exact version.`);
  }
}

const lockRoot = packageLock.packages?.[""];

if (!lockRoot
  || lockRoot.version !== packageManifest.version
  || JSON.stringify(lockRoot.dependencies) !== JSON.stringify(packageManifest.dependencies)) {
  throw new Error("package-lock.json root metadata does not match package.json.");
}

for (const [packagePath, metadata] of Object.entries(packageLock.packages || {})) {
  if (!packagePath || metadata.dev === true) {
    continue;
  }

  if (metadata.hasInstallScript) {
    throw new Error(`Runtime dependency ${packagePath} unexpectedly has an install script.`);
  }

  if (!packagePath.startsWith("node_modules/")
    || !metadata.resolved?.startsWith("https://registry.npmjs.org/")
    || !/^sha(?:256|384|512)-[a-z0-9+/=]+$/iu.test(metadata.integrity || "")) {
    throw new Error(`Runtime dependency ${packagePath} is not locked to an integrity-checked npm artifact.`);
  }
}

await execFileAsync("npm", ["ls", "--omit=dev", "--all"], {
  cwd: projectRoot,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024
});

console.log(`Runtime dependency graph check passed with ${runtimeDependencies.length} direct packages.`);
