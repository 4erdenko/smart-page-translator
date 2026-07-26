import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const archiveDate = new Date("1980-01-01T00:00:00.000Z");
const execFileAsync = promisify(execFile);

function compareArchivePaths(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function generateArchive(archive) {
  return archive.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    type: "nodebuffer"
  });
}

export async function createArchive(sourceDirectory) {
  const archive = new JSZip();

  async function addDirectory(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => compareArchivePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);

      if (entry.isDirectory()) {
        await addDirectory(absolutePath, relativePath);
      } else if (entry.isFile()) {
        archive.file(relativePath, await readFile(absolutePath), {
          createFolders: false,
          date: archiveDate,
          unixPermissions: 0o100644
        });
      }
    }
  }

  await addDirectory(sourceDirectory);
  return generateArchive(archive);
}

export async function createSourceArchive(sourceDirectory, relativePaths) {
  const archive = new JSZip();
  const resolvedSourceDirectory = path.resolve(sourceDirectory);

  for (const relativePath of [...new Set(relativePaths)].sort(compareArchivePaths)) {
    const normalizedPath = String(relativePath).replaceAll("\\", "/");
    const absolutePath = path.resolve(resolvedSourceDirectory, normalizedPath);
    const pathWithinSource = path.relative(resolvedSourceDirectory, absolutePath);

    if (!normalizedPath
      || path.posix.isAbsolute(normalizedPath)
      || path.win32.isAbsolute(normalizedPath)
      || normalizedPath === ".."
      || normalizedPath.startsWith("../")
      || normalizedPath.includes("/../")
      || pathWithinSource === ".."
      || pathWithinSource.startsWith(`..${path.sep}`)
      || path.isAbsolute(pathWithinSource)) {
      throw new Error(`Invalid source path: ${relativePath}`);
    }

    const stats = await lstat(absolutePath);

    if (!stats.isFile()) {
      throw new Error(`Source archive entry must be a regular file: ${relativePath}`);
    }

    archive.file(normalizedPath, await readFile(absolutePath), {
      createFolders: false,
      date: archiveDate,
      unixPermissions: 0o100644
    });
  }

  return generateArchive(archive);
}

export function shouldIncludeSourceFile(relativePath) {
  return Boolean(relativePath)
    && relativePath !== "AGENTS.md"
    && !relativePath.startsWith(".github/")
    && !relativePath.startsWith("store-assets/");
}

async function listTrackedSourceFiles() {
  const gitOptions = {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  };
  const [{ stdout: trackedFiles }, { stdout: untrackedFiles }] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], gitOptions),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], gitOptions)
  ]);

  if (untrackedFiles.split("\0").some(Boolean)) {
    throw new Error("Source packaging requires every non-ignored file to be tracked.");
  }

  return trackedFiles.split("\0").filter(shouldIncludeSourceFile);
}

async function assertCleanTrackedFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }
  );

  if (stdout.trim()) {
    throw new Error("Release packaging requires no staged or unstaged changes to tracked files.");
  }
}

export function validateStoreReleaseIdentity({ head, tag, tagCommit, tagType, version }) {
  const expectedTag = `v${version}`;

  if (tag !== expectedTag) {
    throw new Error(`Store packaging requires the exact release tag ${expectedTag}.`);
  }

  if (tagType !== "tag") {
    throw new Error(`Store packaging requires ${expectedTag} to be an annotated tag.`);
  }

  if (!head || head !== tagCommit) {
    throw new Error(`Store packaging requires ${expectedTag} to point at HEAD.`);
  }
}

async function assertStoreReleaseIdentity() {
  const packageManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const expectedTag = `v${packageManifest.version}`;
  const gitOptions = {
    cwd: projectRoot,
    encoding: "utf8"
  };
  const [{ stdout: head }, { stdout: tagCommit }, { stdout: tagType }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD^{commit}"], gitOptions),
    execFileAsync("git", ["rev-parse", `${expectedTag}^{commit}`], gitOptions)
      .catch(() => ({ stdout: "" })),
    execFileAsync("git", ["cat-file", "-t", `refs/tags/${expectedTag}`], gitOptions)
      .catch(() => ({ stdout: "" }))
  ]);

  validateStoreReleaseIdentity({
    head: head.trim(),
    tag: tagCommit.trim() ? expectedTag : "",
    tagCommit: tagCommit.trim(),
    tagType: tagType.trim(),
    version: packageManifest.version
  });
}

async function listDirectoryFiles(directory, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listDirectoryFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Package source contains an unsupported entry: ${relativePath}`);
    }
  }

  return files.sort(compareArchivePaths);
}

async function verifyArchiveFiles(content, expectedFiles, label) {
  const archive = await JSZip.loadAsync(content);
  const archiveFiles = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .map(({ name }) => name)
    .sort(compareArchivePaths);
  const expected = [...expectedFiles].sort(compareArchivePaths);

  if (JSON.stringify(archiveFiles) !== JSON.stringify(expected)) {
    throw new Error(`${label} archive file list does not match its reviewed source.`);
  }

  return archive;
}

export async function packageTarget(target, { verifyRepository = true } = {}) {
  if (!["chrome", "firefox", "source"].includes(target)) {
    throw new Error("Package target must be firefox, chrome, or source.");
  }

  if (verifyRepository) {
    await assertCleanTrackedFiles();
  }

  const artifactDirectory = path.join(projectRoot, "artifacts");
  const outputPath = path.join(artifactDirectory, `smart-page-translator-${target}.zip`);
  const content = target === "source"
    ? await createSourceArchive(projectRoot, await listTrackedSourceFiles())
    : await createArchive(path.join(projectRoot, "dist", target));
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(outputPath, content);
  console.log(`Packaged ${target} archive in ${outputPath}`);
  return { content, outputPath, target };
}

export async function readVerifiedArchive(outputPath, expectedContent) {
  const content = await readFile(outputPath);

  if (Buffer.compare(content, expectedContent) !== 0) {
    throw new Error(`Written archive does not match generated content: ${path.basename(outputPath)}`);
  }

  return content;
}

async function verifyStorePackages(packages, checksumPath) {
  const packageManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const writtenPackages = [];

  for (const { content: generatedContent, outputPath, target } of packages) {
    const content = await readVerifiedArchive(outputPath, generatedContent);
    const expectedFiles = target === "source"
      ? await listTrackedSourceFiles()
      : await listDirectoryFiles(path.join(projectRoot, "dist", target));
    const archive = await verifyArchiveFiles(content, expectedFiles, target);

    if (target !== "source") {
      const manifest = JSON.parse(await archive.file("manifest.json").async("string"));

      if (manifest.version !== packageManifest.version) {
        throw new Error(`${target} archive manifest version does not match package.json.`);
      }
    }

    writtenPackages.push({ content, outputPath });
  }

  const checksumLines = (await readFile(checksumPath, "utf8")).trim().split("\n");
  const expectedChecksums = writtenPackages.map(({ content, outputPath }) => (
    `${createHash("sha256").update(content).digest("hex")}  ${path.basename(outputPath)}`
  ));

  if (JSON.stringify(checksumLines) !== JSON.stringify(expectedChecksums)) {
    throw new Error("Store package checksums do not match the generated archives.");
  }
}

async function packageStores({ smoke = false } = {}) {
  await assertCleanTrackedFiles();

  if (!smoke) {
    await assertStoreReleaseIdentity();
  }

  const packages = [];

  for (const target of ["firefox", "chrome", "source"]) {
    packages.push(await packageTarget(target, { verifyRepository: false }));
  }

  const checksums = packages
    .map(({ content, outputPath }) => {
      const digest = createHash("sha256").update(content).digest("hex");
      return `${digest}  ${path.basename(outputPath)}`;
    })
    .join("\n");
  const checksumPath = path.join(projectRoot, "artifacts", "SHA256SUMS");
  await writeFile(checksumPath, `${checksums}\n`);
  await verifyStorePackages(packages, checksumPath);
  console.log(`Recorded package checksums in ${checksumPath}`);
  console.log("Verified store archive hashes, manifests, and file lists.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";

  if (target === "stores") {
    await packageStores({ smoke: process.argv.includes("--smoke") });
  } else {
    await packageTarget(target);
  }
}
