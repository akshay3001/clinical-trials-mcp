import { Study, AdditionalExportColumn } from "../models/types.js";
import fs from "fs";
import path from "path";
import Papa from "papaparse";

const EXPORTS_DIR = "./exports";
const BLANK_PLACEHOLDER = "BLANK";

/**
 * Replace null, undefined, or empty string with BLANK placeholder
 */
function sanitizeValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return BLANK_PLACEHOLDER;
  }
  return value;
}

/**
 * Replace empty or undefined array with BLANK, otherwise join with separator
 */
function sanitizeArray(
  arr: string[] | undefined,
  separator: string = "; ",
): string {
  if (!arr || arr.length === 0) {
    return BLANK_PLACEHOLDER;
  }
  const joined = arr.join(separator);
  return joined === "" ? BLANK_PLACEHOLDER : joined;
}

/**
 * Deep sanitization: recursively replace null, undefined, and empty strings with BLANK
 * Preserves 0, false, and other valid falsy values
 */
function sanitizeDeep(value: any): any {
  // Handle null, undefined, empty string
  if (value === null || value === undefined || value === "") {
    return BLANK_PLACEHOLDER;
  }

  // Preserve numbers (including 0) and booleans (including false)
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // Handle arrays - recurse into each element
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return BLANK_PLACEHOLDER;
    }
    return value.map((item) => sanitizeDeep(item));
  }

  // Handle objects - recurse into each property
  if (typeof value === "object") {
    const sanitized: any = {};
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        sanitized[key] = sanitizeDeep(value[key]);
      }
    }
    return sanitized;
  }

  // Return other primitive types (strings) as-is
  return value;
}

/**
 * Ensure exports directory exists and return organized path
 */
function ensureExportsDir(format: string, filename: string): string {
  // Create main exports directory
  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  // Create format subdirectory
  const formatDir = path.join(EXPORTS_DIR, format);
  if (!fs.existsSync(formatDir)) {
    fs.mkdirSync(formatDir, { recursive: true });
  }

  // Return full path
  return path.join(formatDir, filename);
}

/**
 * Get organized export path from user input
 */
export function getExportPath(outputPath: string, format: string): string {
  const filename = path.basename(outputPath);

  // If user provided an absolute path or a path with directories, use it as-is
  if (path.isAbsolute(outputPath) || outputPath.includes(path.sep)) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return outputPath;
  }

  // Otherwise, organize in exports folder
  return ensureExportsDir(format, filename);
}

interface CSVRow {
  NCT_ID: string;
  Title: string;
  Status: string;
  Phase: string;
  Enrollment: string;
  StartDate: string;
  CompletionDate: string;
  Conditions: string;
  Interventions: string;
  PrimaryOutcomes: string;
  SecondaryOutcomes: string;
  Locations: string;
  Sponsor: string;
  Summary: string;
  EligibilityCriteria: string;
  [key: string]: string; // Allow dynamic columns
}

/**
 * Column extractors for additional export columns
 * Each extractor returns the value or BLANK placeholder
 */
const ADDITIONAL_COLUMN_EXTRACTORS: Record<
  AdditionalExportColumn,
  (study: Study) => string
> = {
  MinAge: (study) =>
    sanitizeValue(study.protocolSection?.eligibilityModule?.minimumAge),
  MaxAge: (study) =>
    sanitizeValue(study.protocolSection?.eligibilityModule?.maximumAge),
  Sex: (study) => sanitizeValue(study.protocolSection?.eligibilityModule?.sex),
  SponsorType: (study) =>
    sanitizeValue(
      study.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.class,
    ),
  InterventionType: (study) => {
    const interventions =
      study.protocolSection?.armsInterventionsModule?.interventions || [];
    const types = interventions.map((i) => i.type).filter(Boolean);
    return sanitizeArray(types as string[]);
  },
  IsFDARegulatedDrug: (study) => {
    const value = study.protocolSection?.oversightModule?.isFdaRegulatedDrug;
    return value === true ? "Yes" : value === false ? "No" : BLANK_PLACEHOLDER;
  },
  IsFDARegulatedDevice: (study) => {
    const value = study.protocolSection?.oversightModule?.isFdaRegulatedDevice;
    return value === true ? "Yes" : value === false ? "No" : BLANK_PLACEHOLDER;
  },
  HealthyVolunteers: (study) => {
    const value = study.protocolSection?.eligibilityModule?.healthyVolunteers;
    return value === true ? "Yes" : value === false ? "No" : BLANK_PLACEHOLDER;
  },
  AgeGroups: (study) =>
    sanitizeArray(study.protocolSection?.eligibilityModule?.stdAges, ", "),
  PrimaryPurpose: (study) =>
    sanitizeValue(
      study.protocolSection?.designModule?.designInfo?.primaryPurpose,
    ),
  AllocationMethod: (study) =>
    sanitizeValue(study.protocolSection?.designModule?.designInfo?.allocation),
  InterventionModel: (study) =>
    sanitizeValue(
      study.protocolSection?.designModule?.designInfo?.interventionModel,
    ),
  StudyType: (study) =>
    sanitizeValue(study.protocolSection?.designModule?.studyType),
};

/**
 * Export studies to CSV format
 */
export async function exportToCSV(
  studies: Study[],
  outputPath: string,
  additionalColumns?: AdditionalExportColumn[],
): Promise<string> {
  const finalPath = getExportPath(outputPath, "csv");

  const rows: CSVRow[] = studies.map((study) => {
    const protocol = study.protocolSection;
    const id = protocol.identificationModule;
    const status = protocol.statusModule;
    const description = protocol.descriptionModule;
    const conditions = protocol.conditionsModule;
    const design = protocol.designModule;
    const eligibility = protocol.eligibilityModule;
    const interventions = protocol.armsInterventionsModule;
    const outcomes = protocol.outcomesModule;
    const locations = protocol.contactsLocationsModule;
    const sponsor = protocol.sponsorCollaboratorsModule;

    const row: CSVRow = {
      NCT_ID: id.nctId,
      Title: id.briefTitle,
      Status: status.overallStatus,
      Phase: sanitizeArray(design?.phases, ", "),
      Enrollment: sanitizeValue(design?.enrollmentInfo?.count?.toString()),
      StartDate: sanitizeValue(status.startDateStruct?.date),
      CompletionDate: sanitizeValue(status.completionDateStruct?.date),
      Conditions: sanitizeArray(conditions?.conditions),
      Interventions: sanitizeArray(
        interventions?.interventions?.map((i) => `${i.type}: ${i.name}`),
      ),
      PrimaryOutcomes: sanitizeArray(
        outcomes?.primaryOutcomes
          ?.map((o) => o.measure)
          .filter((m): m is string => m !== undefined),
      ),
      SecondaryOutcomes: sanitizeArray(
        outcomes?.secondaryOutcomes
          ?.map((o) => o.measure)
          .filter((m): m is string => m !== undefined),
      ),
      Locations: sanitizeArray(
        locations?.locations?.map((l) => {
          const parts = [l.facility, l.city, l.state, l.country].filter(
            Boolean,
          );
          return parts.join(", ");
        }),
      ),
      Sponsor: sanitizeValue(sponsor?.leadSponsor?.name),
      Summary: sanitizeValue(description?.briefSummary),
      EligibilityCriteria: sanitizeValue(eligibility?.eligibilityCriteria),
    };

    // Add additional columns if requested
    if (additionalColumns && additionalColumns.length > 0) {
      for (const column of additionalColumns) {
        row[column] = ADDITIONAL_COLUMN_EXTRACTORS[column](study);
      }
    }

    return row;
  });

  const csv = Papa.unparse(rows);
  fs.writeFileSync(finalPath, csv, "utf-8");
  return finalPath;
}

/**
 * Export studies to JSON format
 */
export async function exportToJSON(
  studies: Study[],
  outputPath: string,
): Promise<string> {
  const finalPath = getExportPath(outputPath, "json");
  const sanitizedStudies = sanitizeDeep(studies);
  const json = JSON.stringify(sanitizedStudies, null, 2);
  fs.writeFileSync(finalPath, json, "utf-8");
  return finalPath;
}

/**
 * Export studies to JSONL format (one study per line)
 */
export async function exportToJSONL(
  studies: Study[],
  outputPath: string,
): Promise<string> {
  const finalPath = getExportPath(outputPath, "jsonl");
  const lines = studies
    .map((study) => JSON.stringify(sanitizeDeep(study)))
    .join("\n");
  fs.writeFileSync(finalPath, lines, "utf-8");
  return finalPath;
}
