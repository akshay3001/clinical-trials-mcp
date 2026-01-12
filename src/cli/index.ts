#!/usr/bin/env node

import { Command } from "commander";
import { apiClient } from "../api/client.js";
import { db } from "../db/database.js";
import { cache } from "../utils/cache.js";
import { SearchParams, FilterParams } from "../models/types.js";
import {
  filterStudies,
  generateSessionId,
  formatStudySummary,
  formatStudyList,
} from "../utils/helpers.js";
import { exportToCSV, exportToJSON, exportToJSONL } from "../utils/export.js";

const program = new Command();

program
  .name("clinicaltrials")
  .description(
    "CLI tool for searching and analyzing clinical trials from ClinicalTrials.gov",
  )
  .version("1.0.0");

// Search command
program
  .command("search")
  .description("Search for clinical trials")
  .option("-c, --condition <condition>", "Medical condition")
  .option("-i, --intervention <intervention>", "Treatment or intervention")
  .option("-p, --phase <phase>", 'Trial phase (e.g., "Phase 3")')
  .option("-s, --status <status>", "Recruitment status")
  .option("-l, --location <location>", "Geographic location")
  .option("--sponsor <sponsor>", "Sponsor name")
  .option("-q, --query <query>", "General search query")
  .option("--page-size <size>", "Number of results (1-1000)", "100")
  .action(async (options) => {
    try {
      const searchParams: SearchParams = {
        condition: options.condition,
        intervention: options.intervention,
        phase: options.phase,
        status: options.status,
        location: options.location,
        sponsorSearch: options.sponsor,
        query: options.query,
        pageSize: parseInt(options.pageSize),
      };

      console.log("Searching clinical trials...\n");

      // Make API call
      const response = await apiClient.search(searchParams);
      const studies = response.studies;

      // Store studies in database
      console.log(`Storing ${studies.length} studies in database...`);
      for (const study of studies) {
        db.upsertStudy(study);
      }

      // Cache response
      cache.set("search", searchParams, response);
      cache.saveRawResponse(response, searchParams);

      // Create session
      const sessionId = generateSessionId();
      const nctIds = studies.map(
        (s) => s.protocolSection.identificationModule.nctId,
      );
      db.createSession(sessionId, searchParams, nctIds);

      // Display results
      console.log(formatStudyList(studies, 10));
      console.log(`\n✓ Session ID: ${sessionId}`);
      console.log(
        `\nUse "clinicaltrials filter --session ${sessionId}" to refine results`,
      );
      console.log(
        `Use "clinicaltrials export --session ${sessionId}" to export data`,
      );
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Filter command
program
  .command("filter")
  .description("Refine search results from a session")
  .requiredOption("--session <sessionId>", "Session ID from previous search")
  .option("--country <country>", "Filter by country")
  .option("--state <state>", "Filter by state")
  .option("--city <city>", "Filter by city")
  .option("--enrollment-min <min>", "Minimum enrollment", parseInt)
  .option("--enrollment-max <max>", "Maximum enrollment", parseInt)
  .option("--start-date-after <date>", "Start date after (YYYY-MM-DD)")
  .option("--start-date-before <date>", "Start date before (YYYY-MM-DD)")
  .option("--intervention-type <type>", "Intervention type")
  .option("--has-results", "Only trials with posted results")
  .option(
    "--study-type <type>",
    "Study type (INTERVENTIONAL, OBSERVATIONAL, EXPANDED_ACCESS, PATIENT_REGISTRY)",
  )
  .option("--sex <sex>", "Eligible sex (ALL, MALE, FEMALE)")
  .option("--healthy-volunteers", "Accepts healthy volunteers")
  .option(
    "--sponsor-class <class>",
    "Lead sponsor class (INDUSTRY, NIH, FED, OTHER, INDIV, NETWORK, OTHER_GOV, UNKNOWN)",
  )
  .option(
    "--allocation <type>",
    "Allocation type (RANDOMIZED, NON_RANDOMIZED, N_A)",
  )
  .option(
    "--intervention-model <model>",
    "Intervention model (SINGLE_GROUP, PARALLEL, CROSSOVER, FACTORIAL, SEQUENTIAL)",
  )
  .option(
    "--primary-purpose <purpose>",
    "Primary purpose (TREATMENT, PREVENTION, DIAGNOSTIC, SUPPORTIVE_CARE, SCREENING, HEALTH_SERVICES_RESEARCH, BASIC_SCIENCE, DEVICE_FEASIBILITY, OTHER)",
  )
  .option("--min-age <age>", 'Minimum age (e.g., "18 Years")')
  .option("--max-age <age>", 'Maximum age (e.g., "75 Years")')
  .option(
    "--age-groups <groups>",
    "Age groups (comma-separated: CHILD,ADULT,OLDER_ADULT)",
  )
  .option(
    "--masking <type>",
    "Masking/blinding type (NONE, SINGLE, DOUBLE, TRIPLE, QUADRUPLE)",
  )
  .option("--fda-regulated", "FDA regulated (drug or device)")
  .option("--keyword <keyword>", "Keyword to search in study keywords")
  .action(async (options) => {
    try {
      const sessionId = options.session;

      // Get current session results
      const studies = db.getSessionResults(sessionId);

      if (studies.length === 0) {
        console.error(`Session ${sessionId} not found or has no results`);
        process.exit(1);
      }

      console.log(`Current session has ${studies.length} studies`);
      console.log("Applying filters...\n");

      // Build filter params
      const filterParams: FilterParams = {
        locationCountry: options.country,
        locationState: options.state,
        locationCity: options.city,
        enrollmentMin: options.enrollmentMin,
        enrollmentMax: options.enrollmentMax,
        startDateAfter: options.startDateAfter,
        startDateBefore: options.startDateBefore,
        interventionType: options.interventionType,
        hasResults: options.hasResults,
        studyType: options.studyType as FilterParams["studyType"],
        sex: options.sex as FilterParams["sex"],
        healthyVolunteers: options.healthyVolunteers,
        sponsorClass: options.sponsorClass as FilterParams["sponsorClass"],
        allocation: options.allocation as FilterParams["allocation"],
        interventionModel:
          options.interventionModel as FilterParams["interventionModel"],
        primaryPurpose:
          options.primaryPurpose as FilterParams["primaryPurpose"],
        minAge: options.minAge,
        maxAge: options.maxAge,
        ageGroups: options.ageGroups
          ? (options.ageGroups
              .split(",")
              .map((s: string) =>
                s.trim().toUpperCase(),
              ) as FilterParams["ageGroups"])
          : undefined,
        masking: options.masking as FilterParams["masking"],
        fdaRegulated: options.fdaRegulated,
        keyword: options.keyword,
      };

      // Apply filters
      const filteredStudies = filterStudies(studies, filterParams);

      // Update session
      const nctIds = filteredStudies.map(
        (s) => s.protocolSection.identificationModule.nctId,
      );
      db.updateSessionResults(sessionId, nctIds);

      console.log(`Filtered to ${filteredStudies.length} studies\n`);
      console.log(formatStudyList(filteredStudies, 10));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Get details command
program
  .command("details")
  .description("Get detailed information about a specific trial")
  .requiredOption("--nct-id <nctId>", "NCT ID of the trial")
  .option("--no-eligibility", "Exclude eligibility criteria")
  .action(async (options) => {
    try {
      const nctId = options.nctId;
      const includeEligibility = options.eligibility !== false;

      console.log(`Fetching details for ${nctId}...\n`);

      // Try database first
      let study = db.getStudy(nctId);

      if (!study) {
        console.log("Not in local database, fetching from API...\n");
        study = await apiClient.getStudy(nctId);
        db.upsertStudy(study);
      }

      const summary = formatStudySummary(study, includeEligibility);
      console.log(summary);
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// List session command
program
  .command("list")
  .description("List studies in a session")
  .requiredOption("--session <sessionId>", "Session ID")
  .option("--max <count>", "Maximum number of studies to show", "10")
  .action(async (options) => {
    try {
      const sessionId = options.session;
      const maxResults = parseInt(options.max);

      const studies = db.getSessionResults(sessionId);

      if (studies.length === 0) {
        console.error(`Session ${sessionId} not found or has no results`);
        process.exit(1);
      }

      console.log(formatStudyList(studies, maxResults));
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Export command
program
  .command("export")
  .description("Export search results to a file")
  .requiredOption("--session <sessionId>", "Session ID to export")
  .requiredOption("-f, --format <format>", "Export format (csv, json, jsonl)")
  .requiredOption("-o, --output <path>", "Output file path")
  .action(async (options) => {
    try {
      const sessionId = options.session;
      const format = options.format.toLowerCase();
      const outputPath = options.output;

      if (!["csv", "json", "jsonl"].includes(format)) {
        console.error("Invalid format. Use csv, json, or jsonl");
        process.exit(1);
      }

      console.log(`Exporting session ${sessionId} to ${format}...\n`);

      const studies = db.getSessionResults(sessionId);

      if (studies.length === 0) {
        console.error(`Session ${sessionId} not found or has no results`);
        process.exit(1);
      }

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
          console.error("Invalid format. Use csv, json, or jsonl");
          process.exit(1);
      }

      console.log(`✓ Exported ${studies.length} studies to ${finalPath}`);
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Stats command
program
  .command("stats")
  .description("Get ClinicalTrials.gov database statistics")
  .action(async () => {
    try {
      console.log("Fetching database statistics...\n");

      const version = await apiClient.getVersion();
      const stats = await apiClient.getStats();

      console.log("API Version:", version.apiVersion);
      console.log("Data Timestamp:", version.dataTimestamp);
      console.log("Total Studies:", stats.studyCount);
      console.log("Last Update:", stats.lastUpdateDate);
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

// Clear cache command
program
  .command("clear-cache")
  .description("Clear all cached data")
  .action(() => {
    try {
      cache.clearAll();
      console.log("✓ Cache cleared");
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse();
