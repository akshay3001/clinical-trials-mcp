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

export interface APIRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SearchAllOptions extends APIRequestOptions {
  maxPages?: number;
  maxResults?: number;
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
   * Build query string for ClinicalTrials.gov API
   */
  private buildQuery(params: SearchParams): string {
    const parts: string[] = [];

    if (params.query) {
      parts.push(params.query);
    }

    if (params.condition) {
      parts.push(`AREA[ConditionSearch]${params.condition}`);
    }

    if (params.intervention) {
      parts.push(`AREA[InterventionSearch]${params.intervention}`);
    }

    if (params.sponsorSearch) {
      parts.push(`AREA[SponsorSearch]${params.sponsorSearch}`);
    }

    if (params.location) {
      parts.push(`AREA[LocationSearch]${params.location}`);
    }

    // Phase is included as a regular search term (not an AREA)
    if (params.phase) {
      parts.push(params.phase);
    }

    // Combine with AND
    return parts.length > 0 ? parts.join(" AND ") : "";
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

    // Status must be uppercase (e.g., RECRUITING, COMPLETED)
    if (params.status) {
      urlParams.set("filter.overallStatus", params.status.toUpperCase());
    }

    urlParams.set(
      "pageSize",
      (params.pageSize || DEFAULT_PAGE_SIZE).toString(),
    );

    if (params.pageToken) {
      urlParams.set("pageToken", params.pageToken);
    }

    if (params.fields && params.fields.length > 0) {
      urlParams.set("fields", params.fields.join(","));
    }

    urlParams.set("countTotal", "true");

    return urlParams;
  }

  /**
   * Fetch with retry logic
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

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let lastError: Error | null = null;
    let attempts = 0;

    for (let i = 0; i < retries; i++) {
      signal.throwIfAborted();
      attempts += 1;

      try {
        const response = await fetch(url, { signal });

        if (!response.ok) {
          throw new HTTPResponseError(response.status, response.statusText);
        }

        return response;
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason;
        }

        lastError =
          error instanceof Error ? error : new Error("Unknown fetch error");

        const retryable =
          !(lastError instanceof HTTPResponseError) ||
          lastError.status === 429 ||
          lastError.status >= 500;

        if (retryable && i < retries - 1) {
          // Exponential backoff
          await this.waitForRetry(RETRY_DELAY_MS * Math.pow(2, i), signal);
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
    signal: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal.reason);
      };

      signal.addEventListener("abort", onAbort, { once: true });
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
    const data = (await response.json()) as any;

    // Validate response with Zod using safeParse
    const result = SearchResponseSchema.safeParse(data);

    if (!result.success) {
      console.error(
        "Search response validation failed:",
        result.error.format(),
      );
      // Return partial data with empty studies array if validation fails completely
      return {
        studies: Array.isArray(data.studies) ? data.studies : [],
        nextPageToken: data.nextPageToken,
        totalCount: data.totalCount,
      };
    }

    return result.data;
  }

  /**
   * Get a specific study by NCT ID
   */
  async getStudy(
    nctId: string,
    fields?: string[],
    options: APIRequestOptions = {},
  ): Promise<Study> {
    const urlParams = new URLSearchParams();

    if (fields && fields.length > 0) {
      urlParams.set("fields", fields.join(","));
    }

    const url = `${this.baseUrl}/studies/${nctId}${fields ? `?${urlParams.toString()}` : ""}`;

    const response = await this.fetchWithRetry(url, options);
    const data = (await response.json()) as any;

    // The v2 single-study endpoint returns the study directly. Retain support
    // for the older wrapped shape so cached fixtures and compatible mirrors do
    // not break.
    const rawStudy =
      data && typeof data === "object" && "protocolSection" in data
        ? data
        : Array.isArray(data?.studies)
          ? data.studies[0]
          : undefined;

    if (rawStudy) {
      const result = StudySchema.safeParse(rawStudy);

      if (!result.success) {
        console.error(
          `Study ${nctId} validation failed:`,
          result.error.format(),
        );
        // Return the raw study data even if validation fails
        return rawStudy as Study;
      }

      return result.data;
    }

    throw new Error(`Study ${nctId} not found`);
  }

  /**
   * Get all results by following pagination
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

      const remaining =
        maxResults === undefined ? undefined : maxResults - resultsYielded;
      const studies =
        remaining === undefined
          ? response.studies
          : response.studies.slice(0, remaining);

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
