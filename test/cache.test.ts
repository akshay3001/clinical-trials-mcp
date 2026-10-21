import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const originalWorkingDirectory = process.cwd();
const runtimeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "clinical-trials-cache-test-"),
);
// Configure storage before the cache singleton is imported.
process.chdir(runtimeDirectory);
process.env.CLINICAL_TRIALS_MCP_DATA_DIR = runtimeDirectory;

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

test("raw response logging is off by default and enabled only by explicit opt-in", () => {
  const directory = path.join(runtimeDirectory, "raw-opt-in");
  const manager = new CacheManager(directory);
  const previous = process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES;
  try {
    delete process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES;
    manager.saveRawResponse(
      { studies: [], totalCount: 0 },
      { query: "example" },
    );
    assert.deepEqual(fs.readdirSync(directory), []);
    process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES = "true";
    manager.saveRawResponse(
      { studies: [], totalCount: 0 },
      { query: "example" },
    );
    const [file] = fs.readdirSync(directory);
    assert.match(file, /^raw-.*\.jsonl$/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")).response,
      { studies: [], totalCount: 0 },
    );
  } finally {
    if (previous === undefined)
      delete process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES;
    else process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES = previous;
  }
});

test("keeps the original response timestamp when promoting disk entries to memory", () => {
  const directory = path.join(runtimeDirectory, "response-age");
  const writer = new CacheManager(directory);
  writer.set("search", { query: "age" }, { studies: [] });
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const timestamp = Date.now() - 23 * 60 * 60 * 1000;
  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...entry, timestamp }));
  const reader = new CacheManager(directory);
  // First read is from disk; the second is from memory.
  for (let i = 0; i < 2; i++) {
    assert.equal(
      reader.getEntry<{ studies: unknown[] }>("search", { query: "age" })
        ?.timestamp,
      timestamp,
    );
    if (i === 0) fs.unlinkSync(file);
  }
});
