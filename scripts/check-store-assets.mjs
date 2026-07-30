import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedAssets = new Map([
  ["store-assets/common/logo-300.png", [300, 300]],
  ["store-assets/common/promo-small-440x280.png", [440, 280]],
  ["store-assets/common/promo-marquee-1400x560.png", [1400, 560]]
]);

for (const locale of ["en", "ru"]) {
  for (const name of [
    "01-page-translation.png",
    "02-bilingual-view.png",
    "03-onboarding.png",
    "04-settings.png",
    "05-pdf-workspace.png"
  ]) {
    expectedAssets.set(`store-assets/${locale}/${name}`, [1280, 800]);
  }
}

function readPngDimensions(buffer, relativePath) {
  const signature = buffer.subarray(0, 8).toString("hex");

  if (signature !== "89504e470d0a1a0a" || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${relativePath} is not a valid PNG file.`);
  }

  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

for (const [relativePath, expectedDimensions] of expectedAssets) {
  const buffer = await readFile(path.join(projectRoot, relativePath));
  const dimensions = readPngDimensions(buffer, relativePath);

  if (dimensions[0] !== expectedDimensions[0] || dimensions[1] !== expectedDimensions[1]) {
    throw new Error(
      `${relativePath} must be ${expectedDimensions.join("x")} but is ${dimensions.join("x")}.`
    );
  }
}

console.log(`Store asset check passed with ${expectedAssets.size} PNG files.`);
