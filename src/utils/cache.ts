import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import { SearchResponse } from "../models/types.js";

import { getStoragePaths, STUDY_DATA_TTL_MS } from "./storage.js";
const MEMORY_CACHE_TTL_MS = 60 * 1000; // 1 minute
const DISK_CACHE_TTL_MS = STUDY_DATA_TTL_MS;
const MEMORY_CACHE_MAX_ENTRIES = 100;
// A 10,000-study fetchAll response is about 170 MB. Entries above this size
// are read from disk on each hit instead of being held in memory.
const MEMORY_ENTRY_MAX_BYTES = 20 * 1024 * 1024;
// Total size of entry files that clearExpired keeps. Override it with
// CLINICAL_TRIALS_MCP_CACHE_MAX_BYTES.
const DISK_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// `<prefix>:<hash>.json`: SHA-256 hex keys, and base36 keys from before them
const ENTRY_FILE_PATTERN = /^\w+:[0-9a-z]+\.json$/;

interface CacheOptions {
  // Entries with a larger disk file are not held in the memory cache
  memoryEntryMaxBytes?: number;
}

interface CacheEntry<T> {
  data: T;
  // The params that produced this entry. `get` treats a mismatch as a miss.
  params: unknown;
  timestamp: number;
}

/**
 * Serialize a value as JSON with object keys sorted at every level, so equal
 * params always give the same string.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}

export class CacheManager {
  private memoryCache: Map<string, CacheEntry<unknown> & { loadedAt: number }>;
  private cacheDir: string;
  private memoryEntryMaxBytes: number;

  constructor(
    cacheDir: string = getStoragePaths().cache,
    { memoryEntryMaxBytes = MEMORY_ENTRY_MAX_BYTES }: CacheOptions = {},
  ) {
    this.memoryCache = new Map();
    this.cacheDir = cacheDir;
    this.memoryEntryMaxBytes = memoryEntryMaxBytes;

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Generate cache key from the SHA-256 of the canonical params JSON
   */
  private generateKey(prefix: string, params: object): string {
    const hash = createHash("sha256")
      .update(canonicalJson(params))
      .digest("hex");
    return `${prefix}:${hash}`;
  }

  /**
   * Check that a stored entry was made from the same params
   */
  private matchesParams(entry: CacheEntry<unknown>, params: object): boolean {
    return canonicalJson(entry.params) === canonicalJson(params);
  }

  /**
   * Get from memory cache
   */
  private getFromMemory<T>(key: string, params: object): CacheEntry<T> | null {
    const entry = this.memoryCache.get(key);

    if (!entry || !this.matchesParams(entry, params)) {
      return null;
    }

    const age = Date.now() - entry.loadedAt;
    if (
      age > MEMORY_CACHE_TTL_MS ||
      Date.now() - entry.timestamp > DISK_CACHE_TTL_MS
    ) {
      this.memoryCache.delete(key);
      return null;
    }

    // Move the entry to the end, so the first key is the least recently used
    this.memoryCache.delete(key);
    this.memoryCache.set(key, entry);
    return entry as CacheEntry<T>;
  }

  /** Number of entries held in memory. Used by tests and diagnostics. */
  get memoryEntryCount(): number {
    return this.memoryCache.size;
  }

  /**
   * Drop memory entries past the memory or disk TTL. Entries are otherwise
   * only removed when read or evicted by the size cap, and a 1,000-study page
   * is tens of megabytes, so a long-running server would hold many stale
   * responses.
   */
  private sweepMemory(now = Date.now()): void {
    for (const [key, entry] of this.memoryCache) {
      if (
        now - entry.loadedAt > MEMORY_CACHE_TTL_MS ||
        now - entry.timestamp > DISK_CACHE_TTL_MS
      ) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Set in memory cache, and evict the least recently used entry when full
   */
  private setInMemory<T>(
    key: string,
    params: object,
    data: T,
    timestamp = Date.now(),
  ): void {
    this.sweepMemory();
    this.memoryCache.delete(key);
    this.memoryCache.set(key, {
      data,
      params,
      timestamp,
      loadedAt: Date.now(),
    });

    if (this.memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
      const [oldestKey] = this.memoryCache.keys();
      this.memoryCache.delete(oldestKey);
    }
  }

  /**
   * Get file path for disk cache
   */
  private getDiskCachePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  /**
   * Check that the disk entry for a key is small enough for the memory cache
   */
  private fitsInMemory(key: string): boolean {
    try {
      return (
        fs.statSync(this.getDiskCachePath(key)).size <= this.memoryEntryMaxBytes
      );
    } catch {
      return false;
    }
  }

  /**
   * Get from disk cache
   */
  private getFromDisk<T>(key: string, params: object): CacheEntry<T> | null {
    const filePath = this.getDiskCachePath(key);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry: CacheEntry<T> = JSON.parse(content);

      const age = Date.now() - entry.timestamp;
      if (age > DISK_CACHE_TTL_MS) {
        fs.unlinkSync(filePath);
        return null;
      }

      // Entries without matching params (including the old format) are misses
      if (!this.matchesParams(entry, params)) {
        return null;
      }

      return entry;
    } catch (error) {
      // Invalid cache file, delete it
      fs.unlinkSync(filePath);
      return null;
    }
  }

  /**
   * Set in disk cache. The entry is compact JSON, because a pretty-printed
   * 1,000-study page is about 60% larger. It is written to a temporary file
   * and renamed into place, so a concurrent reader (another server process
   * with the same cache directory) never sees a partial file.
   */
  private setOnDisk<T>(key: string, params: object, data: T): void {
    const filePath = this.getDiskCachePath(key);
    const entry: CacheEntry<T> = {
      data,
      params,
      timestamp: Date.now(),
    };

    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(entry), "utf-8");
    fs.renameSync(tempPath, filePath);
  }

  /**
   * Get cached data (checks memory first, then disk)
   */
  get<T>(prefix: string, params: object): T | null {
    return this.getEntry<T>(prefix, params)?.data ?? null;
  }

  /** Read the response with its original fetch time, including on memory hits. */
  getEntry<T>(prefix: string, params: object): CacheEntry<T> | null {
    const key = this.generateKey(prefix, params);

    // Try memory cache first
    const memoryData = this.getFromMemory<T>(key, params);
    if (memoryData) {
      return memoryData;
    }

    // Try disk cache
    const diskData = this.getFromDisk<T>(key, params);
    if (diskData) {
      // Promote to memory cache, unless the entry is too large to hold there
      if (this.fitsInMemory(key)) {
        this.setInMemory(key, params, diskData.data, diskData.timestamp);
      }
      return diskData;
    }

    return null;
  }

  /**
   * Set cached data on disk, and in memory when the disk entry is small enough
   */
  set<T>(prefix: string, params: object, data: T): void {
    const key = this.generateKey(prefix, params);
    this.setOnDisk(key, params, data);
    if (this.fitsInMemory(key)) {
      this.setInMemory(key, params, data);
    } else {
      // Drop an older, smaller value for the same key
      this.memoryCache.delete(key);
    }
  }

  /**
   * Save raw API response to JSONL file
   */
  saveRawResponse(response: SearchResponse, params: unknown): void {
    if (process.env.CLINICAL_TRIALS_MCP_LOG_RAW_RESPONSES !== "true") return;
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const jsonlPath = path.join(this.cacheDir, `raw-${date}.jsonl`);

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      params,
      response,
    });

    fs.appendFileSync(jsonlPath, line + "\n", "utf-8");
  }

  /** Read the disk cap from the environment, or use the 2 GB default. */
  private diskMaxBytes(): number {
    const value = Number(process.env.CLINICAL_TRIALS_MCP_CACHE_MAX_BYTES);
    return Number.isFinite(value) && value >= 0 ? value : DISK_CACHE_MAX_BYTES;
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.memoryCache.clear();

    const files = fs.readdirSync(this.cacheDir);
    for (const file of files) {
      fs.unlinkSync(path.join(this.cacheDir, file));
    }
  }

  /**
   * Clear expired cache entries. Only entry files that match
   * ENTRY_FILE_PATTERN are checked, so the raw `*.jsonl` response logs and
   * files from other programs are kept. The server calls this at start.
   *
   * Disk age comes from the file modification time, which setOnDisk sets at
   * the same moment as the entry timestamp. A 1,000-study page is tens of
   * megabytes, so parsing every file would make the server slow to start.
   * getFromDisk still removes a file whose content is invalid.
   *
   * After expired entries are removed, the oldest entry files by modification
   * time are removed until their total size is at most the disk cap.
   */
  clearExpired(): void {
    const now = Date.now();
    this.sweepMemory(now);

    // Clear expired disk cache
    const files = fs.readdirSync(this.cacheDir);
    for (const file of files) {
      if (!ENTRY_FILE_PATTERN.test(file)) continue;
      const filePath = path.join(this.cacheDir, file);

      try {
        const age = now - fs.statSync(filePath).mtimeMs;
        if (age > DISK_CACHE_TTL_MS) {
          fs.rmSync(filePath, { force: true });
        }
      } catch {
        // The file was removed by another process between the listing and
        // the stat. Nothing to clear.
      }
    }

    // Remove the oldest entries until the total size is under the cap
    const entries = fs
      .readdirSync(this.cacheDir)
      .filter((file) => ENTRY_FILE_PATTERN.test(file))
      .flatMap((file) => {
        const filePath = path.join(this.cacheDir, file);
        try {
          const { size, mtimeMs } = fs.statSync(filePath);
          return [{ filePath, size, mtimeMs }];
        } catch {
          // Removed by another process since the listing
          return [];
        }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalBytes = entries.reduce((sum, { size }) => sum + size, 0);
    const maxBytes = this.diskMaxBytes();
    for (const { filePath, size } of entries) {
      if (totalBytes <= maxBytes) break;
      fs.rmSync(filePath, { force: true });
      totalBytes -= size;
    }
  }
}

// Export singleton instance
export const cache = new CacheManager();
