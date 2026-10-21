import path from "node:path";
import { fileURLToPath } from "node:url";

// Both src/utils and dist/utils are two levels below the package root.
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const STUDY_DATA_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolve storage without creating directories or depending on the client cwd. */
export function getStoragePaths() {
  const base = path.resolve(
    PACKAGE_ROOT,
    process.env.CLINICAL_TRIALS_MCP_DATA_DIR?.trim() || ".",
  );
  return {
    database: path.join(base, "data", "clinical-trials.db"),
    cache: path.join(base, "cache"),
    exports: process.env.CLINICAL_TRIALS_EXPORTS_DIR?.trim()
      ? path.resolve(process.env.CLINICAL_TRIALS_EXPORTS_DIR.trim())
      : path.join(base, "exports"),
  };
}
