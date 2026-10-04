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

test("evicts the least recently used memory entry past 100 entries", () => {
  const cacheDir = path.join(runtimeDirectory, "lru");
  const manager = new CacheManager(cacheDir);

  for (let i = 0; i < 100; i++) manager.set("search", { i }, `result ${i}`);
  // Reading entry 0 makes entry 1 the least recently used.
  assert.equal(manager.get("search", { i: 0 }), "result 0");
  manager.set("search", { i: 100 }, "result 100");

  // Remove the disk entries, so only the memory cache can answer.
  fs.rmSync(cacheDir, { recursive: true });
  fs.mkdirSync(cacheDir);

  assert.equal(manager.get("search", { i: 0 }), "result 0");
  assert.equal(manager.get("search", { i: 1 }), null);
  assert.equal(manager.get("search", { i: 100 }), "result 100");
});

test("clearExpired removes expired entries and keeps other files", () => {
  const cacheDir = path.join(runtimeDirectory, "expired");
  const manager = new CacheManager(cacheDir);
  manager.set("search", { query: "fresh" }, "fresh results");
  const [freshFile] = fs.readdirSync(cacheDir);

  fs.writeFileSync(
    path.join(cacheDir, "search:expired.json"),
    JSON.stringify({ data: "old", params: {}, timestamp: 0 }),
  );
  fs.writeFileSync(path.join(cacheDir, "search:broken.json"), "not json");
  // A file this cache did not write stays, even when it looks expired.
  fs.writeFileSync(
    path.join(cacheDir, "other.json"),
    JSON.stringify({ timestamp: 0 }),
  );
  fs.writeFileSync(path.join(cacheDir, "raw-2026-01-01.jsonl"), "{}\n{}\n");

  manager.clearExpired();

  assert.deepEqual(fs.readdirSync(cacheDir).sort(), [
    "other.json",
    "raw-2026-01-01.jsonl",
    freshFile,
  ]);
});
