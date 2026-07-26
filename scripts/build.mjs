import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const fontkitRuntimeLicenses = Object.freeze([
  {
    licenseFiles: ["node_modules/@swc/helpers/LICENSE"],
    name: "@swc/helpers",
    packageDirectory: "node_modules/@swc/helpers",
    version: "0.5.23"
  },
  {
    licenseFiles: ["node_modules/base64-js/LICENSE"],
    name: "base64-js",
    packageDirectory: "node_modules/base64-js",
    version: "1.5.1"
  },
  {
    licenseFiles: [
      "third_party/LICENSE.brotli.txt",
      "node_modules/@swc/helpers/LICENSE"
    ],
    name: "brotli",
    packageDirectory: "node_modules/brotli",
    version: "1.3.3"
  },
  {
    licenseFiles: ["node_modules/fontkit/node_modules/clone/LICENSE"],
    name: "clone",
    packageDirectory: "node_modules/fontkit/node_modules/clone",
    version: "2.1.2"
  },
  {
    licenseFiles: ["third_party/LICENSE.dfa.txt"],
    name: "dfa",
    packageDirectory: "node_modules/dfa",
    version: "1.2.0"
  },
  {
    licenseFiles: ["node_modules/fast-deep-equal/LICENSE"],
    name: "fast-deep-equal",
    packageDirectory: "node_modules/fast-deep-equal",
    version: "3.1.3"
  },
  {
    licenseFiles: ["third_party/LICENSE.fontkit.txt"],
    name: "fontkit",
    packageDirectory: "node_modules/fontkit",
    version: "2.0.4"
  },
  {
    licenseFiles: ["node_modules/restructure/LICENSE"],
    name: "restructure",
    packageDirectory: "node_modules/restructure",
    version: "3.0.2"
  },
  {
    licenseFiles: ["node_modules/tiny-inflate/LICENSE"],
    name: "tiny-inflate",
    packageDirectory: "node_modules/tiny-inflate",
    version: "1.0.3"
  },
  {
    licenseFiles: ["node_modules/@swc/helpers/node_modules/tslib/LICENSE.txt"],
    name: "tslib",
    packageDirectory: "node_modules/@swc/helpers/node_modules/tslib",
    version: "2.8.1"
  },
  {
    licenseFiles: ["node_modules/unicode-properties/LICENSE"],
    name: "unicode-properties",
    packageDirectory: "node_modules/unicode-properties",
    version: "1.4.1"
  },
  {
    licenseFiles: ["node_modules/unicode-trie/LICENSE"],
    name: "unicode-trie",
    packageDirectory: "node_modules/unicode-trie",
    version: "2.0.0"
  }
]);
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

function getPackageDirectory(inputPath) {
  const marker = "node_modules/";
  const packageStart = inputPath.lastIndexOf(marker);
  const packagePrefix = inputPath.slice(0, packageStart + marker.length);
  const relativePath = inputPath.slice(packageStart + marker.length);
  const [scopeOrName, scopedName] = relativePath.split("/");
  const packageName = scopeOrName.startsWith("@") ? `${scopeOrName}/${scopedName}` : scopeOrName;
  return `${packagePrefix}${packageName}`;
}

async function buildFontkit(destinationPath) {
  const result = await build({
    bundle: true,
    charset: "utf8",
    entryPoints: [path.join(projectRoot, "scripts", "fontkit-adapter.mjs")],
    format: "iife",
    globalName: "fontkit",
    legalComments: "none",
    minify: true,
    outfile: destinationPath,
    platform: "browser",
    target: ["chrome102", "firefox142"],
    metafile: true
  });
  const runtimePackageDirectories = [...new Set(Object.keys(result.metafile.inputs)
    .filter((inputPath) => inputPath.includes("node_modules/"))
    .map(getPackageDirectory))]
    .sort();
  const reviewedPackageDirectories = fontkitRuntimeLicenses
    .map(({ packageDirectory }) => packageDirectory)
    .sort();

  if (JSON.stringify(runtimePackageDirectories) !== JSON.stringify(reviewedPackageDirectories)) {
    throw new Error(
      `Unexpected fontkit runtime dependency graph: ${runtimePackageDirectories.join(", ") || "empty"}.`
    );
  }

  const bundle = await readFile(destinationPath, "utf8");

  if (/\b(?:eval|Function)\s*\(/u.test(bundle) || /\bimport\s*\(/u.test(bundle)) {
    throw new Error("The generated fontkit bundle contains dynamic code forbidden by the extension CSP.");
  }
}

export function getFontkitRuntimeLicensePackages() {
  return fontkitRuntimeLicenses.map(({ licenseFiles, name, packageDirectory, version }) => ({
    licenseFiles: [...licenseFiles],
    name,
    packageDirectory,
    version
  }));
}

export async function createFontkitNotices() {
  const notices = [];

  for (const { licenseFiles, name, packageDirectory, version } of fontkitRuntimeLicenses) {
    const manifest = JSON.parse(await readFile(
      path.join(projectRoot, packageDirectory, "package.json"),
      "utf8"
    ));

    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`Unexpected licensed package version: ${name}@${manifest.version || "unknown"}.`);
    }

    const licenses = await Promise.all(licenseFiles.map((licenseFile) => (
      readFile(path.join(projectRoot, licenseFile), "utf8")
    )));
    notices.push([
      `${name}@${version}`,
      ...licenses.map((license, index) => [
        `License ${index + 1} of ${licenses.length}: ${licenseFiles[index]}`,
        license.trim()
      ].join("\n\n"))
    ].join("\n\n"));
  }

  const separator = `\n\n${"=".repeat(80)}\n\n`;
  return `${notices.join(separator)}\n`;
}

async function writeFontkitNotices(destinationPath) {
  await writeFile(destinationPath, await createFontkitNotices(), "utf8");
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
  await mkdir(path.join(outputDirectory, "vendor", "export_fonts"), { recursive: true });
  await copyFile(
    path.join(projectRoot, "node_modules", "webextension-polyfill", "dist", "browser-polyfill.min.js"),
    path.join(outputDirectory, "vendor", "browser-polyfill.js")
  );
  await copyFile(
    path.join(projectRoot, "node_modules", "webextension-polyfill", "LICENSE"),
    path.join(outputDirectory, "vendor", "LICENSE.webextension-polyfill.txt")
  );
  await Promise.all([
    buildFontkit(
      path.join(outputDirectory, "vendor", "fontkit.js")
    ),
    writeFontkitNotices(
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
    copyFile(
      path.join(projectRoot, "node_modules", "dejavu-fonts-ttf", "LICENSE"),
      path.join(outputDirectory, "vendor", "LICENSE.dejavu-fonts.txt")
    ),
    ...["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((fontFile) => copyFile(
      path.join(projectRoot, "node_modules", "dejavu-fonts-ttf", "ttf", fontFile),
      path.join(outputDirectory, "vendor", "export_fonts", fontFile)
    )),
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
