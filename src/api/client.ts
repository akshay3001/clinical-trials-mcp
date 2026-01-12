import {
  SearchParams,
  SearchResponse,
  SearchResponseSchema,
  Study,
  StudySchema,
} from "../models/types.js";

const BASE_URL = "https://clinicaltrials.gov/api/v2";
const DEFAULT_PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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
    retries = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response;
      } catch (error) {
        lastError = error as Error;

        if (i < retries - 1) {
          // Exponential backoff
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, i)),
          );
        }
      }
    }

    throw new Error(`Failed after ${retries} retries: ${lastError?.message}`);
  }

  /**
   * Search for clinical trials
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const urlParams = this.buildURLParams(params);
    const url = `${this.baseUrl}/studies?${urlParams.toString()}`;

    const response = await this.fetchWithRetry(url);
    const data = await response.json();

    // Validate response with Zod
    return SearchResponseSchema.parse(data);
  }

  /**
   * Get a specific study by NCT ID
   */
  async getStudy(nctId: string, fields?: string[]): Promise<Study> {
    const urlParams = new URLSearchParams();

    if (fields && fields.length > 0) {
      urlParams.set("fields", fields.join(","));
    }

    const url = `${this.baseUrl}/studies/${nctId}${fields ? `?${urlParams.toString()}` : ""}`;

    const response = await this.fetchWithRetry(url);
    const data = (await response.json()) as any;

    // The response wraps the study in a studies array
    if (data.studies && data.studies.length > 0) {
      return StudySchema.parse(data.studies[0]);
    }

    throw new Error(`Study ${nctId} not found`);
  }

  /**
   * Get all results by following pagination
   */
  async *searchAll(
    params: SearchParams,
  ): AsyncGenerator<Study[], void, unknown> {
    let nextPageToken: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const searchParams = { ...params, pageToken: nextPageToken };
      const response = await this.search(searchParams);

      yield response.studies;

      nextPageToken = response.nextPageToken;
      hasMore = !!nextPageToken;
    }
  }

  /**
   * Get API version and data timestamp
   */
  async getVersion(): Promise<{ apiVersion: string; dataTimestamp: string }> {
    const url = `${this.baseUrl}/version`;
    const response = await this.fetchWithRetry(url);
    return (await response.json()) as {
      apiVersion: string;
      dataTimestamp: string;
    };
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ studyCount: number; lastUpdateDate: string }> {
    const url = `${this.baseUrl}/stats/size`;
    const response = await this.fetchWithRetry(url);
    return (await response.json()) as {
      studyCount: number;
      lastUpdateDate: string;
    };
  }
}

// Export singleton instance
export const apiClient = new ClinicalTrialsAPIClient();
