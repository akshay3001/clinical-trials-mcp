#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { apiClient } from "../api/client.js";
import { db } from "../db/database.js";
import { cache } from "../utils/cache.js";
import {
  SearchParams,
  FilterParams,
  ExportFormat,
  SearchResponse,
  Study,
} from "../models/types.js";
import {
  filterStudies,
  generateSessionId,
  formatStudySummary,
  formatStudyList,
} from "../utils/helpers.js";
import { exportToCSV, exportToJSON, exportToJSONL } from "../utils/export.js";

const server = new Server(
  {
    name: "clinical-trials-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_trials",
        description:
          "Search for clinical trials using various criteria. Returns a session ID for iterative refinement. Searches across 19 specialized areas including conditions, interventions, locations, sponsors, and more.",
        inputSchema: {
          type: "object",
          properties: {
            condition: {
              type: "string",
              description:
                'Medical condition or disease (e.g., "diabetes", "breast cancer", "COVID-19")',
            },
            intervention: {
              type: "string",
              description:
                'Treatment or intervention (e.g., "pembrolizumab", "chemotherapy")',
            },
            phase: {
              type: "string",
              description:
                'Trial phase: "Phase 1", "Phase 2", "Phase 3", "Phase 4", or combinations like "Phase 2|Phase 3"',
            },
            status: {
              type: "string",
              description:
                'Recruitment status: "Recruiting", "Completed", "Active, not recruiting", "Terminated", etc.',
            },
            location: {
              type: "string",
              description: "Geographic location (country, state, or city)",
            },
            sponsorSearch: {
              type: "string",
              description: "Sponsor or collaborator organization name",
            },
            query: {
              type: "string",
              description: "General search query across all fields",
            },
            pageSize: {
              type: "number",
              description: "Number of results to return (1-1000, default 1000)",
              default: 1000,
            },
            fetchAll: {
              type: "boolean",
              description: "Fetch all results using pagination (may take longer for large result sets)",
              default: false,
            },
          },
        },
      },
      {
        name: "refine_results",
        description:
          "Filter existing search results without making a new API call. Applies additional criteria to narrow down results from a previous search session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID from previous search_trials call",
            },
            locationCountry: {
              type: "string",
              description: "Filter by country",
            },
            locationState: {
              type: "string",
              description: "Filter by state/province",
            },
            locationCity: {
              type: "string",
              description: "Filter by city",
            },
            enrollmentMin: {
              type: "number",
              description: "Minimum enrollment count",
            },
            enrollmentMax: {
              type: "number",
              description: "Maximum enrollment count",
            },
            startDateAfter: {
              type: "string",
              description: "Start date after (YYYY-MM-DD)",
            },
            startDateBefore: {
              type: "string",
              description: "Start date before (YYYY-MM-DD)",
            },
            interventionType: {
              type: "string",
              description:
                'Intervention type: "Drug", "Device", "Biological", "Behavioral", etc.',
            },
            hasResults: {
              type: "boolean",
              description: "Filter by whether trial has posted results",
            },
            studyType: {
              type: "string",
              enum: [
                "INTERVENTIONAL",
                "OBSERVATIONAL",
                "EXPANDED_ACCESS",
                "PATIENT_REGISTRY",
              ],
              description: "Filter by study type",
            },
            sex: {
              type: "string",
              enum: ["ALL", "MALE", "FEMALE"],
              description: "Filter by eligible sex",
            },
            healthyVolunteers: {
              type: "boolean",
              description: "Filter by whether trial accepts healthy volunteers",
            },
            sponsorClass: {
              type: "string",
              enum: [
                "INDUSTRY",
                "NIH",
                "FED",
                "OTHER",
                "INDIV",
                "NETWORK",
                "OTHER_GOV",
                "UNKNOWN",
              ],
              description: "Filter by lead sponsor classification",
            },
            allocation: {
              type: "string",
              enum: ["RANDOMIZED", "NON_RANDOMIZED", "N_A"],
              description: "Filter by allocation type (study design)",
            },
            interventionModel: {
              type: "string",
              enum: [
                "SINGLE_GROUP",
                "PARALLEL",
                "CROSSOVER",
                "FACTORIAL",
                "SEQUENTIAL",
              ],
              description: "Filter by intervention model (study design)",
            },
            primaryPurpose: {
              type: "string",
              enum: [
                "TREATMENT",
                "PREVENTION",
                "DIAGNOSTIC",
                "SUPPORTIVE_CARE",
                "SCREENING",
                "HEALTH_SERVICES_RESEARCH",
                "BASIC_SCIENCE",
                "DEVICE_FEASIBILITY",
                "OTHER",
              ],
              description: "Filter by primary purpose of the study",
            },
            minAge: {
              type: "string",
              description:
                'Filter by minimum age (e.g., "18 Years", "65 Years")',
            },
            maxAge: {
              type: "string",
              description: 'Filter by maximum age (e.g., "75 Years", "N/A")',
            },
            ageGroups: {
              type: "array",
              items: {
                type: "string",
                enum: ["CHILD", "ADULT", "OLDER_ADULT"],
              },
              description:
                "Filter by age groups (study must include at least one)",
            },
            masking: {
              type: "string",
              enum: ["NONE", "SINGLE", "DOUBLE", "TRIPLE", "QUADRUPLE"],
              description: "Filter by masking/blinding type",
            },
            fdaRegulated: {
              type: "boolean",
              description: "Filter by FDA regulation status (drug or device)",
            },
            keyword: {
              type: "string",
              description:
                "Filter by keyword (substring search in study keywords)",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_trial_details",
        description:
          "Get detailed information about a specific clinical trial including full summary and eligibility criteria.",
        inputSchema: {
          type: "object",
          properties: {
            nctId: {
              type: "string",
              description: 'NCT ID of the trial (e.g., "NCT12345678")',
            },
            includeEligibility: {
              type: "boolean",
              description: "Include detailed eligibility criteria",
              default: true,
            },
          },
          required: ["nctId"],
        },
      },
      {
        name: "summarize_session",
        description:
          "Get a summary of all trials in a search session with their key details.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID from previous search",
            },
            maxResults: {
              type: "number",
              description:
                "Maximum number of results to show in summary (default 10)",
              default: 10,
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "export_results",
        description:
          "Export search results to a file in CSV, JSON, or JSONL format.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "Session ID to export",
            },
            format: {
              type: "string",
              enum: ["csv", "json", "jsonl"],
              description: "Export format",
            },
            outputPath: {
              type: "string",
              description: "Path to save the file",
            },
          },
          required: ["sessionId", "format", "outputPath"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_trials": {
        const { fetchAll, ...searchParams } = args as unknown as SearchParams & { fetchAll?: boolean };

        // Check cache first
        let cachedResponse = cache.get<SearchResponse>("search", searchParams);

        let studies: Study[];
        if (cachedResponse) {
          studies = cachedResponse.studies;
        } else if (fetchAll) {
          // Fetch all results using pagination
          studies = [];
          for await (const batch of apiClient.searchAll(searchParams)) {
            studies.push(...batch);
          }
          // Cache the combined response
          const response: SearchResponse = {
            studies,
            nextPageToken: undefined,
            totalCount: studies.length,
          };
          cache.set("search", searchParams, response);
          cache.saveRawResponse(response, searchParams);
        } else {
          // Make single API call
          const response = await apiClient.search(searchParams);
          studies = response.studies;

          // Cache response
          cache.set("search", searchParams, response);
          cache.saveRawResponse(response, searchParams);
        }

        // Store studies in database
        for (const study of studies) {
          db.upsertStudy(study);
        }

        // Create session for refinement
        const sessionId = generateSessionId();
        const nctIds = studies.map(
          (s: Study) => s.protocolSection.identificationModule.nctId,
        );
        db.createSession(sessionId, searchParams, nctIds);

        // Format output
        const summary = formatStudyList(studies, 10);

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n**Session ID:** ${sessionId}\n\nUse this session ID to refine results, get summaries, or export data.`,
            },
          ],
        };
      }

      case "refine_results": {
        const { sessionId, ...filterParams } = args as unknown as {
          sessionId: string;
        } & FilterParams;

        // Get current session results
        const studies = db.getSessionResults(sessionId);

        if (studies.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${sessionId} not found or has no results.`,
              },
            ],
          };
        }

        // Apply filters
        const filteredStudies = filterStudies(studies, filterParams);

        // Update session with filtered results
        const nctIds = filteredStudies.map(
          (s) => s.protocolSection.identificationModule.nctId,
        );
        db.updateSessionResults(sessionId, nctIds);

        const summary = formatStudyList(filteredStudies, 10);

        return {
          content: [
            {
              type: "text",
              text: `Filtered to ${filteredStudies.length} studies (from ${studies.length})\n\n${summary}`,
            },
          ],
        };
      }

      case "get_trial_details": {
        const { nctId, includeEligibility = true } = args as {
          nctId: string;
          includeEligibility?: boolean;
        };

        // Try to get from database first
        let study = db.getStudy(nctId);

        if (!study) {
          // Fetch from API
          study = await apiClient.getStudy(nctId);
          db.upsertStudy(study);
        }

        const summary = formatStudySummary(study, includeEligibility);

        return {
          content: [
            {
              type: "text",
              text: summary,
            },
          ],
        };
      }

      case "summarize_session": {
        const { sessionId, maxResults = 10 } = args as {
          sessionId: string;
          maxResults?: number;
        };

        const studies = db.getSessionResults(sessionId);

        if (studies.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${sessionId} not found or has no results.`,
              },
            ],
          };
        }

        const summary = formatStudyList(studies, maxResults);

        return {
          content: [
            {
              type: "text",
              text: summary,
            },
          ],
        };
      }

      case "export_results": {
        const { sessionId, format, outputPath } = args as {
          sessionId: string;
          format: ExportFormat;
          outputPath: string;
        };

        const studies = db.getSessionResults(sessionId);

        if (studies.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Session ${sessionId} not found or has no results.`,
              },
            ],
          };
        }

        // Export based on format
        let finalPath: string;
        switch (format) {
          case "csv":
            finalPath = await exportToCSV(studies, outputPath);
            break;
          case "json":
            finalPath = await exportToJSON(studies, outputPath);
            break;
          case "jsonl":
            finalPath = await exportToJSONL(studies, outputPath);
            break;
          default:
            throw new Error(`Unknown format: ${format}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `✓ Exported ${studies.length} studies to ${finalPath}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Clinical Trials MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
