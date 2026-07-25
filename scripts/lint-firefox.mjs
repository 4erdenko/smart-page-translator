import { spawnSync } from "node:child_process";

const allowedVendorWarnings = new Set([
  "DANGEROUS_EVAL:The Function constructor is eval.:vendor/pdf.mjs",
  "DANGEROUS_EVAL:The Function constructor is eval.:vendor/pdf.worker.mjs",
  "UNSAFE_VAR_ASSIGNMENT:Unsafe call to import for argument 0:vendor/pdf.mjs",
  "UNSAFE_VAR_ASSIGNMENT:Unsafe call to import for argument 0:vendor/pdf.worker.mjs"
]);
const executable = process.platform === "win32" ? "addons-linter.cmd" : "addons-linter";
const result = spawnSync(executable, ["dist/firefox", "--output", "json"], {
  encoding: "utf8"
});

if (result.error) {
  throw result.error;
}

if (!result.stdout) {
  process.stderr.write(result.stderr || "Mozilla add-on linter returned no output.\n");
  process.exitCode = 1;
} else {
  const report = JSON.parse(result.stdout);
  const unexpectedWarnings = report.warnings.filter((warning) => !allowedVendorWarnings.has(
    `${warning.code}:${warning.message}:${warning.file}`
  ));

  if (report.errors.length > 0 || unexpectedWarnings.length > 0 || result.status !== 0) {
    process.stderr.write(`${JSON.stringify({
      errors: report.errors,
      warnings: unexpectedWarnings
    }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Mozilla validation passed; ${report.warnings.length} documented PDF.js warnings allowed.\n`
    );
  }
}
