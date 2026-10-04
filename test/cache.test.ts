import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const originalWorkingDirectory = process.cwd();
const runtimeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "clinical-trials-cache-test-"),
);
// The cache module creates ./cache on import, so import it from a temp cwd.
process.chdir(runtimeDirectory);

const { CacheManager } = await import("../src/utils/cache.js");

test.after(() => {
  process.chdir(originalWorkingDirectory);
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

test("keys searches by SHA-256 and treats a stored-params mismatch as a miss", () => {
  const cacheDir = path.join(runtimeDirectory, "collision");
  const writer = new CacheManager(cacheDir);

  // "Aa" and "BB" had the same 32-bit Java-style hash.
  writer.set("search", { query: "Aa" }, "Aa results");
  assert.equal(writer.get("search", { query: "BB" }), null);
  assert.equal(writer.get("search", { query: "Aa" }), "Aa results");

  const [fileName] = fs.readdirSync(cacheDir);
  assert.match(fileName, /^search:[0-9a-f]{64}\.json$/);

  // Rewrite the stored params so they no longer match the key's params.
  const filePath = path.join(cacheDir, fileName);
  const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ...entry, params: { query: "BB" } }),
  );

  // A fresh instance has an empty memory cache, so this reads the disk entry.
  assert.equal(new CacheManager(cacheDir).get("search", { query: "Aa" }), null);
});
