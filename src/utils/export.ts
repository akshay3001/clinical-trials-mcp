import { Study, AdditionalExportColumn } from "../models/types.js";
import fs from "fs";
import path from "path";
import Papa from "papaparse";

const EXPORTS_ROOT_ENV = "CLINICAL_TRIALS_EXPORTS_DIR";
const DEFAULT_EXPORTS_DIR = "exports";
const ALLOWED_EXPORT_FORMATS = new Set(["csv", "json", "jsonl"]);
const CSV_FORMULA_PATTERN = /^[\s\uFEFF]*(?:[=+\-@]|[\t\r\n])/;
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
function sanitizeDeep(value: unknown): unknown {
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
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = sanitizeDeep(nestedValue);
    }
    return sanitized;
  }

  // Return other primitive types (strings) as-is
  return value;
}

/**
 * Return true when candidate is the root itself or one of its descendants.
 */
function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * Create the configured export root and resolve it to its canonical location.
 * Resolving the root itself permits an intentionally configured symlink while
 * preventing paths below it from escaping through another symlink.
 */
function getExportsRoot(): string {
  const configuredRoot = process.env[EXPORTS_ROOT_ENV]?.trim();
  const root = path.resolve(configuredRoot || DEFAULT_EXPORTS_DIR);

  fs.mkdirSync(root, { recursive: true });
  const rootStats = fs.statSync(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`Configured export root is not a directory: ${root}`);
  }

  return fs.realpathSync(root);
}

/**
 * Create each missing directory without following symlinks below the export
 * root. Creating one component at a time avoids recursive mkdir traversing an
 * existing symlink before it can be checked.
 */
function ensureSafeDirectory(root: string, directory: string): void {
  if (!isWithinRoot(root, directory)) {
    throw new Error(`Export path must remain within the export root: ${root}`);
  }

  const relative = path.relative(root, directory);
  if (relative === "") {
    return;
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);

    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Export path cannot contain symbolic links: ${current}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(`Export path component is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(current);
    }
  }

  if (fs.realpathSync(directory) !== directory) {
    throw new Error(
      `Export path cannot escape through symbolic links: ${directory}`,
    );
  }
}

/**
 * Reject an existing destination instead of silently replacing it. The write
 * itself also uses the exclusive "wx" flag to make the policy race-safe.
 */
function assertNewDestination(destination: string): void {
  try {
    fs.lstatSync(destination);
    throw new Error(
      `Refusing to overwrite existing export file: ${destination}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function writeExportFile(destination: string, contents: string): void {
  const root = getExportsRoot();
  if (!isWithinRoot(root, destination)) {
    throw new Error(`Export path must remain within the export root: ${root}`);
  }

  ensureSafeDirectory(root, path.dirname(destination));
  assertNewDestination(destination);

  try {
    fs.writeFileSync(destination, contents, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Refusing to overwrite existing export file: ${destination}`,
      );
    }
    throw error;
  }
}

/**
 * Get a contained export path from user input. Bare filenames retain the
 * existing organization by format (for example exports/csv/results.csv).
 * Explicit relative paths are resolved below the configured export root, while
 * absolute paths are accepted only when already below that root.
 */
export function getExportPath(outputPath: string, format: string): string {
  if (!ALLOWED_EXPORT_FORMATS.has(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  if (outputPath.trim() === "" || outputPath.includes("\0")) {
    throw new Error("Export output path must be a non-empty valid path");
  }

  const root = getExportsRoot();
  const isBareFilename = path.basename(outputPath) === outputPath;
  let destination: string;

  if (isBareFilename) {
    destination = path.resolve(root, format, outputPath);
  } else if (path.isAbsolute(outputPath)) {
    destination = path.resolve(outputPath);
  } else {
    destination = path.resolve(root, outputPath);
  }

  if (!isWithinRoot(root, destination) || destination === root) {
    throw new Error(`Export path must remain within the export root: ${root}`);
  }

  ensureSafeDirectory(root, path.dirname(destination));
  assertNewDestination(destination);
  return destination;
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

  const csv = Papa.unparse(rows, { escapeFormulae: CSV_FORMULA_PATTERN });
  writeExportFile(finalPath, csv);
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
  writeExportFile(finalPath, json);
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
  writeExportFile(finalPath, lines);
  return finalPath;
}
