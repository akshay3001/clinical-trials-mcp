import {
  SearchParams,
  SearchResponse,
  SearchResponseSchema,
  Study,
  StudySchema,
} from "../models/types.js";

const BASE_URL = "https://clinicaltrials.gov/api/v2";
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 30_000;

export interface APIRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchAllOptions extends APIRequestOptions {
  maxPages?: number;
  maxResults?: number;
}

/**
 * Convert a Retry-After header (delay seconds or HTTP date) to a wait in
 * milliseconds, capped at MAX_RETRY_AFTER_MS. Returns undefined when the
 * header is missing or invalid, so the caller uses exponential backoff.
 */
function parseRetryAfter(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;

  const delayMs = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  if (Number.isNaN(delayMs)) return undefined;

  return Math.min(Math.max(delayMs, 0), MAX_RETRY_AFTER_MS);
}

class HTTPResponseError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HTTPResponseError";
  }
}

export class ClinicalTrialsAPIClient {
  private baseUrl: string;

  constructor(baseUrl: string = BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Build the Essie `query.term` expression. Each part is put in parentheses
   * before the parts are joined with AND. In Essie, AND binds tighter than
   * OR, so an ungrouped "heart OR lung" would leak out of its own part.
   */
  private buildQuery(params: SearchParams): string {
    return [
      params.query && `(${params.query})`,
      params.condition && `AREA[ConditionSearch](${params.condition})`,
      params.intervention && `AREA[InterventionSearch](${params.intervention})`,
      params.sponsorSearch && `AREA[SponsorSearch](${params.sponsorSearch})`,
      params.location && `AREA[LocationSearch](${params.location})`,
      params.phase && `AREA[Phase](${params.phase.join(" OR ")})`,
    ]
      .filter(Boolean)
      .join(" AND ");
  }

  /**
   * Build URL search parameters
   */
  private buildURLParams(params: SearchParams): URLSearchParams {
    const urlParams = new URLSearchParams();

    const query = this.buildQuery(params);
    if (query) {
      urlParams.set("query.term", query);
    }

    // The API takes a comma-separated list of status enum values.
    if (params.status) {
      urlParams.set("filter.overallStatus", params.status.join(","));
    }

    urlParams.set(
      "pageSize",
      (params.pageSize || DEFAULT_PAGE_SIZE).toString(),
    );

    if (params.pageToken) {
      urlParams.set("pageToken", params.pageToken);
    }

    urlParams.set("countTotal", "true");

    return urlParams;
  }

  /**
   * Fetch with up to `retries` attempts. Each attempt has its own timeout.
   * A caller abort stops the attempt and any backoff wait at once.
   */
  private async fetchWithRetry(
    url: string,
    options: APIRequestOptions = {},
    retries = MAX_RETRIES,
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }

    let lastError: Error | null = null;
    let attempts = 0;

    for (let i = 0; i < retries; i++) {
      options.signal?.throwIfAborted();
      attempts += 1;

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      let retryAfterMs: number | undefined;

      try {
        const response = await fetch(url, { signal });

        if (!response.ok) {
          if (response.status === 429) {
            retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          }
          throw new HTTPResponseError(response.status, response.statusText);
        }

        return response;
      } catch (error) {
        options.signal?.throwIfAborted();

        // A timed-out attempt is retryable, like a network error.
        lastError =
          error instanceof Error ? error : new Error("Unknown fetch error");

        const retryable =
          !(lastError instanceof HTTPResponseError) ||
          lastError.status === 429 ||
          lastError.status >= 500;

        if (retryable && i < retries - 1) {
          await this.waitForRetry(
            retryAfterMs ?? RETRY_DELAY_MS * Math.pow(2, i),
            options.signal,
          );
        } else {
          break;
        }
      }
    }

    throw new Error(
      `Request failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}: ${lastError?.message}`,
    );
  }

  private async waitForRetry(
    delayMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal?.reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Search for clinical trials
   */
  async search(
    params: SearchParams,
    options: APIRequestOptions = {},
  ): Promise<SearchResponse> {
    const urlParams = this.buildURLParams(params);
    const url = `${this.baseUrl}/studies?${urlParams.toString()}`;

    const response = await this.fetchWithRetry(url, options);
    const data: unknown = await response.json();

    const result = SearchResponseSchema.safeParse(data);
    if (result.success) return result.data;

    // One malformed study should not discard a whole page. Keep only the
    // studies that parse; the final parse still rejects an invalid envelope.
    if (
      typeof data !== "object" ||
      data === null ||
      !("studies" in data) ||
      !Array.isArray(data.studies)
    ) {
      throw new Error("ClinicalTrials.gov returned an invalid search response");
    }

    const studies = data.studies.flatMap((study: unknown) => {
      const parsed = StudySchema.safeParse(study);
      return parsed.success ? [parsed.data] : [];
    });
    console.error(
      `Dropped ${data.studies.length - studies.length} invalid studies from search response`,
    );

    return SearchResponseSchema.parse({ ...data, studies });
  }

  /**
   * Get a specific study by NCT ID
   */
  async getStudy(
    nctId: string,
    options: APIRequestOptions = {},
  ): Promise<Study> {
    const url = `${this.baseUrl}/studies/${nctId}`;

    const response = await this.fetchWithRetry(url, options);
    const data: unknown = await response.json();

    // The v2 single-study endpoint returns the study directly. Retain support
    // for the older wrapped shape so cached fixtures and compatible mirrors do
    // not break.
    const rawStudy =
      data && typeof data === "object"
        ? "protocolSection" in data
          ? data
          : "studies" in data && Array.isArray(data.studies)
            ? data.studies[0]
            : undefined
        : undefined;

    if (rawStudy) {
      const result = StudySchema.safeParse(rawStudy);

      if (!result.success) {
        console.error(
          `Study ${nctId} validation failed:`,
          result.error.format(),
        );
        throw new Error(
          `ClinicalTrials.gov returned an invalid study ${nctId}`,
        );
      }

      return result.data;
    }

    throw new Error(`Study ${nctId} not found`);
  }

  /**
   * Get all results by following pagination. Upstream data can change between
   * page requests, so a study can appear on two pages; only its first
   * occurrence is yielded, in API order.
   */
  async *searchAll(
    params: SearchParams,
    options: SearchAllOptions = {},
  ): AsyncGenerator<Study[], void, unknown> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxResults = options.maxResults;

    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new RangeError("maxPages must be a positive integer");
    }
    if (
      maxResults !== undefined &&
      (!Number.isInteger(maxResults) || maxResults <= 0)
    ) {
      throw new RangeError("maxResults must be a positive integer");
    }

    let nextPageToken: string | undefined = undefined;
    let hasMore = true;
    let pagesFetched = 0;
    let resultsYielded = 0;
    const seenPageTokens = new Set<string>();
    const seenNctIds = new Set<string>();

    while (hasMore) {
      options.signal?.throwIfAborted();

      if (nextPageToken) {
        if (seenPageTokens.has(nextPageToken)) {
          throw new Error("ClinicalTrials.gov returned a repeated page token");
        }
        seenPageTokens.add(nextPageToken);
      }

      const searchParams = { ...params, pageToken: nextPageToken };
      const response = await this.search(searchParams, options);
      pagesFetched += 1;

      const newStudies = response.studies.filter((study) => {
        const nctId = study.protocolSection.identificationModule.nctId;
        if (seenNctIds.has(nctId)) return false;
        seenNctIds.add(nctId);
        return true;
      });
      const remaining =
        maxResults === undefined ? undefined : maxResults - resultsYielded;
      const studies =
        remaining === undefined ? newStudies : newStudies.slice(0, remaining);

      yield studies;
      resultsYielded += studies.length;

      nextPageToken = response.nextPageToken;
      hasMore =
        !!nextPageToken &&
        (maxResults === undefined || resultsYielded < maxResults);

      if (hasMore && pagesFetched >= maxPages) {
        throw new Error(`Pagination limit of ${maxPages} pages reached`);
      }
    }
  }

  /**
   * Get API version and data timestamp
   */
  async getVersion(
    options: APIRequestOptions = {},
  ): Promise<{ apiVersion: string; dataTimestamp: string }> {
    const url = `${this.baseUrl}/version`;
    const response = await this.fetchWithRetry(url, options);
    return (await response.json()) as {
      apiVersion: string;
      dataTimestamp: string;
    };
  }

  /**
   * Get database statistics
   */
  async getStats(
    options: APIRequestOptions = {},
  ): Promise<{ studyCount: number; lastUpdateDate: string }> {
    const url = `${this.baseUrl}/stats/size`;
    const response = await this.fetchWithRetry(url, options);
    return (await response.json()) as {
      studyCount: number;
      lastUpdateDate: string;
    };
  }
}

// Export singleton instance
export const apiClient = new ClinicalTrialsAPIClient();
