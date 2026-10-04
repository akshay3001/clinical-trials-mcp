import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import { SearchResponse } from "../models/types.js";

const CACHE_DIR = "./cache";
const MEMORY_CACHE_TTL_MS = 60 * 1000; // 1 minute
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MEMORY_CACHE_MAX_ENTRIES = 100;

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
  private memoryCache: Map<string, CacheEntry<unknown>>;
  private cacheDir: string;

  constructor(cacheDir: string = CACHE_DIR) {
    this.memoryCache = new Map();
    this.cacheDir = cacheDir;

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
  private getFromMemory<T>(key: string, params: object): T | null {
    const entry = this.memoryCache.get(key);

    if (!entry || !this.matchesParams(entry, params)) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > MEMORY_CACHE_TTL_MS) {
      this.memoryCache.delete(key);
      return null;
    }

    // Move the entry to the end, so the first key is the least recently used
    this.memoryCache.delete(key);
    this.memoryCache.set(key, entry);
    return entry.data as T;
  }

  /**
   * Set in memory cache, and evict the least recently used entry when full
   */
  private setInMemory<T>(key: string, params: object, data: T): void {
    this.memoryCache.delete(key);
    this.memoryCache.set(key, {
      data,
      params,
      timestamp: Date.now(),
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
   * Get from disk cache
   */
  private getFromDisk<T>(key: string, params: object): T | null {
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

      return entry.data;
    } catch (error) {
      // Invalid cache file, delete it
      fs.unlinkSync(filePath);
      return null;
    }
  }

  /**
   * Set in disk cache
   */
  private setOnDisk<T>(key: string, params: object, data: T): void {
    const filePath = this.getDiskCachePath(key);
    const entry: CacheEntry<T> = {
      data,
      params,
      timestamp: Date.now(),
    };

    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  /**
   * Get cached data (checks memory first, then disk)
   */
  get<T>(prefix: string, params: object): T | null {
    const key = this.generateKey(prefix, params);

    // Try memory cache first
    const memoryData = this.getFromMemory<T>(key, params);
    if (memoryData) {
      return memoryData;
    }

    // Try disk cache
    const diskData = this.getFromDisk<T>(key, params);
    if (diskData) {
      // Promote to memory cache
      this.setInMemory(key, params, diskData);
      return diskData;
    }

    return null;
  }

  /**
   * Set cached data (sets both memory and disk)
   */
  set<T>(prefix: string, params: object, data: T): void {
    const key = this.generateKey(prefix, params);
    this.setInMemory(key, params, data);
    this.setOnDisk(key, params, data);
  }

  /**
   * Save raw API response to JSONL file
   */
  saveRawResponse(response: SearchResponse, params: any): void {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const jsonlPath = path.join(this.cacheDir, `raw-${date}.jsonl`);

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      params,
      response,
    });

    fs.appendFileSync(jsonlPath, line + "\n", "utf-8");
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
   * Clear expired cache entries. Only `*.json` entry files are checked; the
   * raw `*.jsonl` response logs are kept. The server calls this at start.
   */
  clearExpired(): void {
    // Clear expired memory cache
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      const age = now - entry.timestamp;
      if (age > MEMORY_CACHE_TTL_MS) {
        this.memoryCache.delete(key);
      }
    }

    // Clear expired disk cache
    const files = fs.readdirSync(this.cacheDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(this.cacheDir, file);

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const entry = JSON.parse(content);

        const age = now - entry.timestamp;
        if (age > DISK_CACHE_TTL_MS) {
          fs.rmSync(filePath, { force: true });
        }
      } catch (error) {
        // Invalid file, delete it
        fs.rmSync(filePath, { force: true });
      }
    }
  }
}

// Export singleton instance
export const cache = new CacheManager();
