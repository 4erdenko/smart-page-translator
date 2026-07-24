import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const archiveDate = new Date("1980-01-01T00:00:00.000Z");

export async function createArchive(sourceDirectory) {
  const archive = new JSZip();

  async function addDirectory(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
  return archive.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    type: "nodebuffer"
  });
}

async function packageTarget(target) {
  if (!["chrome", "firefox"].includes(target)) {
    throw new Error("Package target must be firefox or chrome.");
  }

  const sourceDirectory = path.join(projectRoot, "dist", target);
  const artifactDirectory = path.join(projectRoot, "artifacts");
  const outputPath = path.join(artifactDirectory, `smart-page-translator-${target}.zip`);
  const content = await createArchive(sourceDirectory);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(outputPath, content);
  console.log(`Packaged ${target} extension in ${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : "firefox";
  await packageTarget(target);
}
