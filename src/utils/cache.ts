import fs from "fs";
import path from "path";
import { SearchResponse } from "../models/types.js";

const CACHE_DIR = "./cache";
const MEMORY_CACHE_TTL_MS = 60 * 1000; // 1 minute
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class CacheManager {
  private memoryCache: Map<string, CacheEntry<any>>;
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
   * Generate cache key from object
   */
  private generateKey(prefix: string, params: any): string {
    const paramsStr = JSON.stringify(params, Object.keys(params).sort());
    return `${prefix}:${this.hashString(paramsStr)}`;
  }

  /**
   * Simple string hash function
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get from memory cache
   */
  private getFromMemory<T>(key: string): T | null {
    const entry = this.memoryCache.get(key);

    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > MEMORY_CACHE_TTL_MS) {
      this.memoryCache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set in memory cache
   */
  private setInMemory<T>(key: string, data: T): void {
    this.memoryCache.set(key, {
      data,
      timestamp: Date.now(),
    });
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
  private getFromDisk<T>(key: string): T | null {
    const filePath = this.getDiskCachePath(key);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = this.parseCacheEntry<T>(content);

      const age = Date.now() - entry.timestamp;
      if (age > DISK_CACHE_TTL_MS) {
        fs.unlinkSync(filePath);
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
  private setOnDisk<T>(key: string, data: T): void {
    const filePath = this.getDiskCachePath(key);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
    };

    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  private parseCacheEntry<T>(content: string): CacheEntry<T> {
    const entry: unknown = JSON.parse(content);
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid cache entry");
    }

    const cacheEntry = entry as Record<string, unknown>;
    if (
      !Object.hasOwn(cacheEntry, "data") ||
      !Object.hasOwn(cacheEntry, "timestamp") ||
      typeof cacheEntry.timestamp !== "number" ||
      !Number.isFinite(cacheEntry.timestamp)
    ) {
      throw new Error("Invalid cache entry");
    }

    return {
      data: cacheEntry.data as T,
      timestamp: cacheEntry.timestamp,
    };
  }

  /**
   * Get cached data (checks memory first, then disk)
   */
  get<T>(prefix: string, params: any): T | null {
    const key = this.generateKey(prefix, params);

    // Try memory cache first
    const memoryData = this.getFromMemory<T>(key);
    if (memoryData !== null) {
      return memoryData;
    }

    // Try disk cache
    const diskData = this.getFromDisk<T>(key);
    if (diskData !== null) {
      // Promote to memory cache
      this.setInMemory(key, diskData);
      return diskData;
    }

    return null;
  }

  /**
   * Set cached data (sets both memory and disk)
   */
  set<T>(prefix: string, params: any, data: T): void {
    const key = this.generateKey(prefix, params);
    this.setInMemory(key, data);
    this.setOnDisk(key, data);
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
   * Clear expired cache entries
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
      if (!file.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.cacheDir, file);

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const entry = this.parseCacheEntry<unknown>(content);

        const age = now - entry.timestamp;
        if (age > DISK_CACHE_TTL_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        // Invalid file, delete it
        fs.unlinkSync(filePath);
      }
    }
  }
}

// Export singleton instance
export const cache = new CacheManager();
