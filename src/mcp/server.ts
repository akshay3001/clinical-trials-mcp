#!/usr/bin/env node

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { apiClient } from "../api/client.js";
import { db } from "../db/database.js";
import { cache } from "../utils/cache.js";
import {
  type AdditionalExportColumn,
  type ExportFormat,
  type FilterParams,
  type SearchParams,
  type SearchResponse,
  type Study,
} from "../models/types.js";
import {
  filterStudies,
  formatStudyList,
  formatStudySummary,
  generateSessionId,
} from "../utils/helpers.js";
import { exportToCSV, exportToJSON, exportToJSONL } from "../utils/export.js";

const SERVER_NAME = "clinical-trials-mcp";
const SERVER_VERSION = "2.0.0";
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_FETCH_LIMIT = 10_000;
const MAX_FETCH_PAGES = 100;
const MAX_CONCURRENT_API_OPERATIONS = 4;

let activeApiOperations = 0;
const apiOperationQueue: Array<() => void> = [];

const boundedText = (description: string, maxLength = 500) =>
  z.string().trim().min(1).max(maxLength).describe(description);

const sessionIdSchema = boundedText(
  "Session ID from a previous search_trials call",
  128,
);

const isoDateSchema = z.iso.date().describe("Date in YYYY-MM-DD format");

const searchTrialsInputSchema = z
  .object({
    condition: boundedText(
      'Medical condition or disease (for example, "diabetes" or "breast cancer")',
    ).optional(),
    intervention: boundedText(
      'Treatment or intervention (for example, "pembrolizumab")',
    ).optional(),
    phase: boundedText(
      'Trial phase, such as "Phase 1" or "Phase 2|Phase 3"',
      200,
    ).optional(),
    status: boundedText(
      'Recruitment status, such as "Recruiting" or "Completed"',
      200,
    ).optional(),
    location: boundedText(
      "Geographic location (country, state, or city)",
    ).optional(),
    sponsorSearch: boundedText(
      "Sponsor or collaborator organization name",
    ).optional(),
    query: boundedText(
      "General search query across all fields",
      2_000,
    ).optional(),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(DEFAULT_PAGE_SIZE)
      .describe("Number of studies per API page (1-1000; default 1000)"),
    fetchAll: z
      .boolean()
      .default(false)
      .describe("Follow pagination and fetch multiple pages"),
    fetchLimit: z
      .number()
      .int()
      .min(1)
      .max(DEFAULT_FETCH_LIMIT)
      .default(DEFAULT_FETCH_LIMIT)
      .describe(
        "Maximum total studies to return when fetchAll is true (1-10000; default 10000)",
      ),
  })
  .strict()
  .superRefine(({ fetchAll, fetchLimit, pageSize }, ctx) => {
    if (fetchAll && fetchLimit > pageSize * MAX_FETCH_PAGES) {
      ctx.addIssue({
        code: "custom",
        message: `fetchLimit cannot exceed pageSize × ${MAX_FETCH_PAGES} when fetchAll is true`,
        path: ["fetchLimit"],
      });
    }
  });

const studyTypeSchema = z.enum([
  "INTERVENTIONAL",
  "OBSERVATIONAL",
  "EXPANDED_ACCESS",
  "PATIENT_REGISTRY",
]);
const sexSchema = z.enum(["ALL", "MALE", "FEMALE"]);
const sponsorClassSchema = z.enum([
  "INDUSTRY",
  "NIH",
  "FED",
  "OTHER",
  "INDIV",
  "NETWORK",
  "OTHER_GOV",
  "UNKNOWN",
]);
const allocationSchema = z.enum(["RANDOMIZED", "NON_RANDOMIZED", "N_A"]);
const interventionModelSchema = z.enum([
  "SINGLE_GROUP",
  "PARALLEL",
  "CROSSOVER",
  "FACTORIAL",
  "SEQUENTIAL",
]);
const primaryPurposeSchema = z.enum([
  "TREATMENT",
  "PREVENTION",
  "DIAGNOSTIC",
  "SUPPORTIVE_CARE",
  "SCREENING",
  "HEALTH_SERVICES_RESEARCH",
  "BASIC_SCIENCE",
  "DEVICE_FEASIBILITY",
  "OTHER",
]);
const ageGroupSchema = z.enum(["CHILD", "ADULT", "OLDER_ADULT"]);
const maskingSchema = z.enum([
  "NONE",
  "SINGLE",
  "DOUBLE",
  "TRIPLE",
  "QUADRUPLE",
]);

const refineResultsInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    locationCountry: boundedText("Filter by country").optional(),
    locationState: boundedText("Filter by state or province").optional(),
    locationCity: boundedText("Filter by city").optional(),
    enrollmentMin: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .describe("Minimum enrollment count")
      .optional(),
    enrollmentMax: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .describe("Maximum enrollment count")
      .optional(),
    startDateAfter: isoDateSchema
      .describe("Start date after (YYYY-MM-DD)")
      .optional(),
    startDateBefore: isoDateSchema
      .describe("Start date before (YYYY-MM-DD)")
      .optional(),
    interventionType: boundedText(
      "Filter by intervention type",
      200,
    ).optional(),
    hasResults: z
      .boolean()
      .describe("Filter by whether results are posted")
      .optional(),
    studyType: studyTypeSchema.describe("Filter by study type").optional(),
    sex: sexSchema.describe("Filter by eligible sex").optional(),
    healthyVolunteers: z
      .boolean()
      .describe("Filter by whether healthy volunteers are accepted")
      .optional(),
    sponsorClass: sponsorClassSchema
      .describe("Filter by lead sponsor classification")
      .optional(),
    allocation: allocationSchema
      .describe("Filter by allocation type")
      .optional(),
    interventionModel: interventionModelSchema
      .describe("Filter by intervention model")
      .optional(),
    primaryPurpose: primaryPurposeSchema
      .describe("Filter by primary purpose")
      .optional(),
    minAge: boundedText('Minimum age, such as "18 Years"', 100).optional(),
    maxAge: boundedText(
      'Maximum age, such as "75 Years" or "N/A"',
      100,
    ).optional(),
    ageGroups: z
      .array(ageGroupSchema)
      .min(1)
      .max(3)
      .describe("Study must include at least one specified age group")
      .optional(),
    masking: maskingSchema
      .describe("Filter by masking or blinding type")
      .optional(),
    fdaRegulated: z
      .boolean()
      .describe("Filter by FDA drug or device regulation status")
      .optional(),
    keyword: boundedText("Substring to find in study keywords").optional(),
  })
  .strict()
  .refine(
    ({ enrollmentMin, enrollmentMax }) =>
      enrollmentMin === undefined ||
      enrollmentMax === undefined ||
      enrollmentMin <= enrollmentMax,
    {
      message: "enrollmentMin must be less than or equal to enrollmentMax",
      path: ["enrollmentMax"],
    },
  )
  .refine(
    ({ startDateAfter, startDateBefore }) =>
      startDateAfter === undefined ||
      startDateBefore === undefined ||
      startDateAfter <= startDateBefore,
    {
      message: "startDateAfter must be before or equal to startDateBefore",
      path: ["startDateBefore"],
    },
  );

const getTrialDetailsInputSchema = z
  .object({
    nctId: z
      .string()
      .regex(/^NCT\d{8}$/, "nctId must use the format NCT12345678")
      .describe("ClinicalTrials.gov NCT identifier"),
    includeEligibility: z
      .boolean()
      .default(true)
      .describe("Include detailed eligibility criteria"),
  })
  .strict();

const summarizeSessionInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(10)
      .describe("Maximum number of studies to include (1-1000; default 10)"),
  })
  .strict();

const additionalExportColumnSchema = z.enum([
  "MinAge",
  "MaxAge",
  "Sex",
  "SponsorType",
  "InterventionType",
  "IsFDARegulatedDrug",
  "IsFDARegulatedDevice",
  "HealthyVolunteers",
  "AgeGroups",
  "PrimaryPurpose",
  "AllocationMethod",
  "InterventionModel",
  "StudyType",
]);

const exportResultsInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    format: z.enum(["csv", "json", "jsonl"]).describe("Export format"),
    outputPath: boundedText("Path or filename for the exported file", 4096),
    additionalColumns: z
      .array(additionalExportColumnSchema)
      .max(13)
      .refine((columns) => new Set(columns).size === columns.length, {
        message: "additionalColumns must not contain duplicates",
      })
      .describe("Additional columns for CSV exports")
      .optional(),
  })
  .strict();

function releaseApiPermit(): void {
  const next = apiOperationQueue.shift();
  if (next) {
    next();
  } else {
    activeApiOperations -= 1;
  }
}

async function acquireApiPermit(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let settled = false;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      releaseApiPermit();
    };

    const grant = () => {
      if (signal.aborted) {
        settled = true;
        reject(signal.reason);
        releaseApiPermit();
        return;
      }

      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(release);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      const queueIndex = apiOperationQueue.indexOf(grant);
      if (queueIndex >= 0) apiOperationQueue.splice(queueIndex, 1);
      reject(signal.reason);
    };

    if (activeApiOperations < MAX_CONCURRENT_API_OPERATIONS) {
      activeApiOperations += 1;
      grant();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      apiOperationQueue.push(grant);
    }
  });
}

async function withApiPermit<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireApiPermit(signal);
  try {
    return await operation();
  } finally {
    release();
  }
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function emptySessionResult(sessionId: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Session ${sessionId} has no results.`,
      },
    ],
  };
}

function missingSessionResult(sessionId: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Session ${sessionId} was not found.`,
      },
    ],
    isError: true,
  };
}

function sessionNotFoundOrEmpty(sessionId: string): CallToolResult {
  const sessionExists = db.sessionExists(sessionId);
  return sessionExists
    ? emptySessionResult(sessionId)
    : missingSessionResult(sessionId);
}

/** Build a fresh MCP server instance for either the modern or legacy protocol era. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "search_trials",
    {
      title: "Search Clinical Trials",
      description:
        "Search ClinicalTrials.gov using condition, intervention, location, sponsor, phase, status, or general terms. Returns only the result count and a session ID; call summarize_session when you want study summaries.",
      inputSchema: searchTrialsInputSchema,
    },
    async ({ fetchAll, fetchLimit, ...searchParamsInput }, ctx) => {
      try {
        ctx.mcpReq.signal.throwIfAborted();
        const searchParams: SearchParams = searchParamsInput;
        const cacheParams = fetchAll
          ? { ...searchParams, fetchAll, fetchLimit }
          : searchParams;
        const cachedResponse = cache.get<SearchResponse>("search", cacheParams);

        let studies: Study[];
        if (cachedResponse) {
          studies = fetchAll
            ? cachedResponse.studies.slice(0, fetchLimit)
            : cachedResponse.studies;
        } else if (fetchAll) {
          studies = await withApiPermit(ctx.mcpReq.signal, async () => {
            const fetchedStudies: Study[] = [];
            for await (const batch of apiClient.searchAll(searchParams, {
              signal: ctx.mcpReq.signal,
              maxResults: fetchLimit,
            })) {
              ctx.mcpReq.signal.throwIfAborted();
              const remaining = fetchLimit - fetchedStudies.length;
              fetchedStudies.push(...batch.slice(0, remaining));
              if (fetchedStudies.length >= fetchLimit) break;
            }
            return fetchedStudies;
          });

          const response: SearchResponse = {
            studies,
            nextPageToken: undefined,
            totalCount: studies.length,
          };
          cache.set("search", cacheParams, response);
          cache.saveRawResponse(response, searchParams);
        } else {
          ctx.mcpReq.signal.throwIfAborted();
          const response = await withApiPermit(ctx.mcpReq.signal, () =>
            apiClient.search(searchParams, {
              signal: ctx.mcpReq.signal,
            }),
          );
          ctx.mcpReq.signal.throwIfAborted();
          studies = response.studies;
          cache.set("search", cacheParams, response);
          cache.saveRawResponse(response, searchParams);
        }

        for (const [index, study] of studies.entries()) {
          ctx.mcpReq.signal.throwIfAborted();
          db.upsertStudy(study);
          if ((index + 1) % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        ctx.mcpReq.signal.throwIfAborted();

        const sessionId = generateSessionId();
        const nctIds = studies.map(
          (study) => study.protocolSection.identificationModule.nctId,
        );
        db.createSession(sessionId, searchParams, nctIds);

        return {
          content: [
            {
              type: "text",
              text: `Search found ${studies.length.toLocaleString("en-US")} ${studies.length === 1 ? "study" : "studies"}.\n**Session ID:** ${sessionId}\n\nUse this session ID to refine results, call summarize_session for study summaries, or export data.`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "refine_results",
    {
      title: "Refine Trial Results",
      description:
        "Filter results from an existing search session without making a new ClinicalTrials.gov API call. Returns only the before/after counts and session ID; call summarize_session when you want study summaries.",
      inputSchema: refineResultsInputSchema,
    },
    async ({ sessionId, ...filterParamsInput }) => {
      try {
        const studies = db.getSessionResults(sessionId);
        if (studies.length === 0) return sessionNotFoundOrEmpty(sessionId);

        const filteredStudies = filterStudies(
          studies,
          filterParamsInput as FilterParams,
        );
        const nctIds = filteredStudies.map(
          (study) => study.protocolSection.identificationModule.nctId,
        );
        db.updateSessionResults(sessionId, nctIds);

        return {
          content: [
            {
              type: "text",
              text: `Filtered from ${studies.length.toLocaleString("en-US")} to ${filteredStudies.length.toLocaleString("en-US")} ${filteredStudies.length === 1 ? "study" : "studies"}.\n**Session ID:** ${sessionId}\n\nUse this session ID for further refinement, call summarize_session for study summaries, or export data.`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_trial_details",
    {
      title: "Get Trial Details",
      description:
        "Get detailed information about one clinical trial, including its full summary and optional eligibility criteria.",
      inputSchema: getTrialDetailsInputSchema,
    },
    async ({ nctId, includeEligibility }, ctx) => {
      try {
        ctx.mcpReq.signal.throwIfAborted();
        let study = db.getStudy(nctId);
        if (!study) {
          study = await withApiPermit(ctx.mcpReq.signal, () =>
            apiClient.getStudy(nctId, undefined, {
              signal: ctx.mcpReq.signal,
            }),
          );
          ctx.mcpReq.signal.throwIfAborted();
          db.upsertStudy(study);
        }

        return {
          content: [
            {
              type: "text",
              text: formatStudySummary(study, includeEligibility),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "summarize_session",
    {
      title: "Summarize Search Session",
      description:
        "Return study summaries from a search session after search or refinement.",
      inputSchema: summarizeSessionInputSchema,
    },
    async ({ sessionId, maxResults }) => {
      try {
        const studies = db.getSessionResults(sessionId);
        if (studies.length === 0) return sessionNotFoundOrEmpty(sessionId);

        return {
          content: [
            {
              type: "text",
              text: formatStudyList(studies, maxResults),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "export_results",
    {
      title: "Export Search Results",
      description: "Export a search session to a CSV, JSON, or JSONL file.",
      inputSchema: exportResultsInputSchema,
    },
    async ({ sessionId, format, outputPath, additionalColumns }) => {
      try {
        const studies = db.getSessionResults(sessionId);
        if (studies.length === 0) return sessionNotFoundOrEmpty(sessionId);

        let finalPath: string;
        switch (format as ExportFormat) {
          case "csv":
            finalPath = await exportToCSV(
              studies,
              outputPath,
              additionalColumns as AdditionalExportColumn[] | undefined,
            );
            break;
          case "json":
            finalPath = await exportToJSON(studies, outputPath);
            break;
          case "jsonl":
            finalPath = await exportToJSONL(studies, outputPath);
            break;
        }

        return {
          content: [
            {
              type: "text",
              text: `✓ Exported ${studies.length} studies to ${finalPath}`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function main(): void {
  serveStdio(createServer, {
    onerror: (error) => console.error("MCP stdio error:", error),
  });
  console.error("Clinical Trials MCP Server running on stdio");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
