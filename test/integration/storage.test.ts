import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("src and dist use the package root from a different cwd without creating storage", () => {
  const env = { ...process.env };
  delete env.CLINICAL_TRIALS_MCP_DATA_DIR;
  delete env.CLINICAL_TRIALS_EXPORTS_DIR;
  for (const directory of ["src", "dist"]) {
    const module = new URL(
      `../../${directory}/utils/storage.${directory === "src" ? "ts" : "js"}`,
      import.meta.url,
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `const { getStoragePaths } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(getStoragePaths()));`,
      ],
      { cwd: "/", env, encoding: "utf8" },
    );
    const configured = execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `const { getStoragePaths } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(getStoragePaths()));`,
      ],
      {
        cwd: "/",
        env: {
          ...env,
          CLINICAL_TRIALS_MCP_DATA_DIR: "custom-storage",
          CLINICAL_TRIALS_EXPORTS_DIR: "/tmp/custom-exports",
        },
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(configured), {
      database: path.join(root, "custom-storage", "data", "clinical-trials.db"),
      cache: path.join(root, "custom-storage", "cache"),
      exports: "/tmp/custom-exports",
    });
    assert.deepEqual(JSON.parse(output), {
      database: path.join(root, "data", "clinical-trials.db"),
      cache: path.join(root, "cache"),
      exports: path.join(root, "exports"),
    });
  }
});
