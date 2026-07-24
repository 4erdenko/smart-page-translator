import { execFile } from "node:child_process";
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

  return trackedFiles.split("\0").filter(Boolean);
}

async function packageTarget(target) {
  if (!["chrome", "firefox", "source"].includes(target)) {
    throw new Error("Package target must be firefox, chrome, or source.");
  }

  const artifactDirectory = path.join(projectRoot, "artifacts");
  const outputPath = path.join(artifactDirectory, `smart-page-translator-${target}.zip`);
  const content = target === "source"
    ? await createSourceArchive(projectRoot, await listTrackedSourceFiles())
    : await createArchive(path.join(projectRoot, "dist", target));
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(outputPath, content);
  console.log(`Packaged ${target} archive in ${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";
  await packageTarget(target);
}
