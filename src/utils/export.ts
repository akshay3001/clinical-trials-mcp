import { Study } from '../models/types.js';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

const EXPORTS_DIR = './exports';

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
  Locations: string;
  Sponsor: string;
  Summary: string;
  EligibilityCriteria: string;
}

/**
 * Export studies to CSV format
 */
export async function exportToCSV(studies: Study[], outputPath: string): Promise<string> {
  const finalPath = getExportPath(outputPath, 'csv');
  
  const rows: CSVRow[] = studies.map(study => {
    const protocol = study.protocolSection;
    const id = protocol.identificationModule;
    const status = protocol.statusModule;
    const description = protocol.descriptionModule;
    const conditions = protocol.conditionsModule;
    const design = protocol.designModule;
    const eligibility = protocol.eligibilityModule;
    const interventions = protocol.armsInterventionsModule;
    const locations = protocol.contactsLocationsModule;
    const sponsor = protocol.sponsorCollaboratorsModule;

    return {
      NCT_ID: id.nctId,
      Title: id.briefTitle,
      Status: status.overallStatus,
      Phase: design?.phases?.join(', ') || '',
      Enrollment: design?.enrollmentInfo?.count?.toString() || '',
      StartDate: status.startDateStruct?.date || '',
      CompletionDate: status.completionDateStruct?.date || '',
      Conditions: conditions?.conditions?.join('; ') || '',
      Interventions: interventions?.interventions?.map(i => `${i.type}: ${i.name}`).join('; ') || '',
      Locations: locations?.locations?.map(l => {
        const parts = [l.facility, l.city, l.state, l.country].filter(Boolean);
        return parts.join(', ');
      }).join('; ') || '',
      Sponsor: sponsor?.leadSponsor?.name || '',
      Summary: description?.briefSummary || '',
      EligibilityCriteria: eligibility?.eligibilityCriteria || '',
    };
  });

  const csv = Papa.unparse(rows);
  fs.writeFileSync(finalPath, csv, 'utf-8');
  return finalPath;
}

/**
 * Export studies to JSON format
 */
export async function exportToJSON(studies: Study[], outputPath: string): Promise<string> {
  const finalPath = getExportPath(outputPath, 'json');
  const json = JSON.stringify(studies, null, 2);
  fs.writeFileSync(finalPath, json, 'utf-8');
  return finalPath;
}

/**
 * Export studies to JSONL format (one study per line)
 */
export async function exportToJSONL(studies: Study[], outputPath: string): Promise<string> {
  const finalPath = getExportPath(outputPath, 'jsonl');
  const lines = studies.map(study => JSON.stringify(study)).join('\n');
  fs.writeFileSync(finalPath, lines, 'utf-8');
  return finalPath;
}
