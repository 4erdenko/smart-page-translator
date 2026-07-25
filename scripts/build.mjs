import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const localeFiles = Object.freeze(["en", "ru"].map((locale) => `_locales/${locale}/messages.json`));
const sharedSourceFiles = Object.freeze([
  ...localeFiles,
  "assets/icon-16.png",
  "assets/icon-32.png",
  "assets/icon-48.png",
  "assets/icon-96.png",
  "assets/icon-128.png",
  "assets/icon.svg",
  "background.js",
  "content.js",
  "lib/document-core.js",
  "lib/dom-core.js",
  "lib/provider-core.js",
  "lib/translation-core.js",
  "lib/ui-i18n.js",
  "onboarding/onboarding.css",
  "onboarding/onboarding.html",
  "onboarding/onboarding.js",
  "options/options.css",
  "options/options.html",
  "options/options.js",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "pdf/pdf.css",
  "pdf/pdf.html",
  "pdf/pdf.js"
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

async function writeCspSafeFontkit(destinationPath) {
  const sourcePath = path.join(
    projectRoot,
    "node_modules",
    "@pdf-lib",
    "fontkit",
    "dist",
    "fontkit.umd.min.js"
  );
  const unsafeBinder = 'r=Function("binder","return function ("+o.join(",")+"){ return binder.apply(this,arguments); }")(i)';
  const unsafeEvalReference = '"%eval%":eval';
  let source = await readFile(sourcePath, "utf8");

  if (!source.includes(unsafeBinder) || !source.includes(unsafeEvalReference)) {
    throw new Error("The pinned fontkit bundle no longer matches the reviewed CSP patch.");
  }

  source = source
    .replace(unsafeBinder, "r=function(){return i.apply(this,arguments)}")
    .replace(unsafeEvalReference, '"%eval%":void 0');

  if (source.includes(unsafeBinder) || source.includes(unsafeEvalReference)) {
    throw new Error("The fontkit CSP patch did not remove every reviewed dynamic-code reference.");
  }

  await writeFile(destinationPath, source, "utf8");
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
  await Promise.all([
    writeCspSafeFontkit(
      path.join(outputDirectory, "vendor", "fontkit.js")
    ),
    copyFile(
      path.join(projectRoot, "third_party", "LICENSE.fontkit.txt"),
      path.join(outputDirectory, "vendor", "LICENSE.fontkit.txt")
    ),
    copyFile(
      path.join(projectRoot, "node_modules", "pdf-lib", "dist", "pdf-lib.min.js"),
      path.join(outputDirectory, "vendor", "pdf-lib.js")
    ),
    copyFile(
      path.join(projectRoot, "node_modules", "pdf-lib", "LICENSE.md"),
      path.join(outputDirectory, "vendor", "LICENSE.pdf-lib.txt")
    ),
    copyFile(
      path.join(projectRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.min.mjs"),
      path.join(outputDirectory, "vendor", "pdf.mjs")
    ),
    copyFile(
      path.join(projectRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"),
      path.join(outputDirectory, "vendor", "pdf.worker.mjs")
    ),
    copyFile(
      path.join(projectRoot, "node_modules", "pdfjs-dist", "LICENSE"),
      path.join(outputDirectory, "vendor", "LICENSE.pdfjs.txt")
    ),
    ...["cmaps", "standard_fonts", "wasm"].map((directory) => cp(
      path.join(projectRoot, "node_modules", "pdfjs-dist", directory),
      path.join(outputDirectory, "vendor", directory),
      { recursive: true }
    ))
  ]);
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
