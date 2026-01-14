import Database from "better-sqlite3";
import { Study } from "../models/types.js";
import path from "path";
import fs from "fs";

const DEFAULT_DB_PATH = "./data/clinical-trials.db";

export class DatabaseManager {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.initialize();
  }

  /**
   * Initialize database schema
   */
  private initialize(): void {
    this.db.exec(`
      -- Core studies table
      CREATE TABLE IF NOT EXISTS studies (
        nct_id TEXT PRIMARY KEY,
        brief_title TEXT NOT NULL,
        official_title TEXT,
        acronym TEXT,
        overall_status TEXT,
        study_type TEXT,
        phase TEXT,
        enrollment_count INTEGER,
        enrollment_type TEXT,
        start_date TEXT,
        start_date_type TEXT,
        primary_completion_date TEXT,
        completion_date TEXT,
        last_update_posted TEXT,
        has_results BOOLEAN DEFAULT 0,
        brief_summary TEXT,
        detailed_description TEXT,
        eligibility_criteria TEXT,
        sex TEXT,
        minimum_age TEXT,
        maximum_age TEXT,
        healthy_volunteers BOOLEAN,
        lead_sponsor_name TEXT,
        lead_sponsor_class TEXT,
        -- New denormalized fields for efficient filtering
        allocation TEXT,
        intervention_model TEXT,
        primary_purpose TEXT,
        masking TEXT,
        is_fda_regulated_drug BOOLEAN,
        is_fda_regulated_device BOOLEAN,
        age_groups TEXT,
        raw_json TEXT NOT NULL,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Conditions (many-to-many)
      CREATE TABLE IF NOT EXISTS conditions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        condition TEXT NOT NULL,
        UNIQUE(nct_id, condition)
      );

      -- Interventions (many-to-many)
      CREATE TABLE IF NOT EXISTS interventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        intervention_type TEXT NOT NULL,
        intervention_name TEXT NOT NULL,
        description TEXT,
        UNIQUE(nct_id, intervention_type, intervention_name)
      );

      -- Locations (many-to-many)
      CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        facility TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        status TEXT,
        latitude REAL,
        longitude REAL,
        UNIQUE(nct_id, facility, city, state, country)
      );

      -- Keywords
      CREATE TABLE IF NOT EXISTS keywords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        UNIQUE(nct_id, keyword)
      );

      -- Primary outcomes (many-to-many)
      CREATE TABLE IF NOT EXISTS primary_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        measure TEXT NOT NULL,
        description TEXT,
        time_frame TEXT,
        UNIQUE(nct_id, measure, time_frame)
      );

      -- Secondary outcomes (many-to-many)
      CREATE TABLE IF NOT EXISTS secondary_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        measure TEXT NOT NULL,
        description TEXT,
        time_frame TEXT,
        UNIQUE(nct_id, measure, time_frame)
      );

      -- Search sessions for iterative refinement
      CREATE TABLE IF NOT EXISTS search_sessions (
        session_id TEXT PRIMARY KEY,
        search_params TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Session results (many-to-many between sessions and studies)
      CREATE TABLE IF NOT EXISTS session_results (
        session_id TEXT NOT NULL REFERENCES search_sessions(session_id) ON DELETE CASCADE,
        nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
        PRIMARY KEY (session_id, nct_id)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_studies_status ON studies(overall_status);
      CREATE INDEX IF NOT EXISTS idx_studies_phase ON studies(phase);
      CREATE INDEX IF NOT EXISTS idx_studies_start_date ON studies(start_date);
      CREATE INDEX IF NOT EXISTS idx_studies_study_type ON studies(study_type);
      CREATE INDEX IF NOT EXISTS idx_studies_sponsor_class ON studies(lead_sponsor_class);
      CREATE INDEX IF NOT EXISTS idx_studies_allocation ON studies(allocation);
      CREATE INDEX IF NOT EXISTS idx_studies_intervention_model ON studies(intervention_model);
      CREATE INDEX IF NOT EXISTS idx_studies_primary_purpose ON studies(primary_purpose);
      CREATE INDEX IF NOT EXISTS idx_studies_masking ON studies(masking);
      CREATE INDEX IF NOT EXISTS idx_studies_fda_drug ON studies(is_fda_regulated_drug);
      CREATE INDEX IF NOT EXISTS idx_studies_fda_device ON studies(is_fda_regulated_device);
      CREATE INDEX IF NOT EXISTS idx_conditions_condition ON conditions(condition);
      CREATE INDEX IF NOT EXISTS idx_interventions_type ON interventions(intervention_type);
      CREATE INDEX IF NOT EXISTS idx_interventions_name ON interventions(intervention_name);
      CREATE INDEX IF NOT EXISTS idx_locations_country ON locations(country);
      CREATE INDEX IF NOT EXISTS idx_locations_state ON locations(state);
      CREATE INDEX IF NOT EXISTS idx_locations_city ON locations(city);
      CREATE INDEX IF NOT EXISTS idx_primary_outcomes_measure ON primary_outcomes(measure);
      CREATE INDEX IF NOT EXISTS idx_secondary_outcomes_measure ON secondary_outcomes(measure);

      -- Full-text search virtual table
      CREATE VIRTUAL TABLE IF NOT EXISTS studies_fts USING fts5(
        nct_id UNINDEXED,
        brief_title,
        official_title,
        brief_summary,
        detailed_description,
        content=studies,
        content_rowid=rowid
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS studies_ai AFTER INSERT ON studies BEGIN
        INSERT INTO studies_fts(rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
        VALUES (new.rowid, new.nct_id, new.brief_title, new.official_title, new.brief_summary, new.detailed_description);
      END;

      CREATE TRIGGER IF NOT EXISTS studies_ad AFTER DELETE ON studies BEGIN
        DELETE FROM studies_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS studies_au AFTER UPDATE ON studies BEGIN
        UPDATE studies_fts 
        SET brief_title = new.brief_title,
            official_title = new.official_title,
            brief_summary = new.brief_summary,
            detailed_description = new.detailed_description
        WHERE rowid = new.rowid;
      END;
    `);

    // Run migration to add new columns if they don't exist
    this.migrateSchema();
  }

  /**
   * Migrate database schema to add new columns
   */
  private migrateSchema(): void {
    // Check if new columns exist, if not add them
    const columns = this.db.pragma('table_info(studies)') as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);

    const newColumns = [
      { name: 'allocation', type: 'TEXT' },
      { name: 'intervention_model', type: 'TEXT' },
      { name: 'primary_purpose', type: 'TEXT' },
      { name: 'masking', type: 'TEXT' },
      { name: 'is_fda_regulated_drug', type: 'BOOLEAN' },
      { name: 'is_fda_regulated_device', type: 'BOOLEAN' },
      { name: 'age_groups', type: 'TEXT' },
    ];

    for (const column of newColumns) {
      if (!columnNames.includes(column.name)) {
        this.db.exec(`ALTER TABLE studies ADD COLUMN ${column.name} ${column.type}`);
      }
    }

    // Backfill new columns from raw_json for existing data
    this.backfillDenormalizedFields();
  }

  /**
   * Backfill denormalized fields from raw_json
   */
  private backfillDenormalizedFields(): void {
    const stmt = this.db.prepare('SELECT nct_id, raw_json FROM studies WHERE allocation IS NULL OR is_fda_regulated_drug IS NULL');
    const rows = stmt.all() as Array<{ nct_id: string; raw_json: string }>;

    if (rows.length === 0) return;

    const updateStmt = this.db.prepare(`
      UPDATE studies 
      SET allocation = @allocation,
          intervention_model = @interventionModel,
          primary_purpose = @primaryPurpose,
          masking = @masking,
          is_fda_regulated_drug = @isFdaRegulatedDrug,
          is_fda_regulated_device = @isFdaRegulatedDevice,
          age_groups = @ageGroups
      WHERE nct_id = @nctId
    `);

    for (const row of rows) {
      try {
        const study = JSON.parse(row.raw_json) as Study;
        const protocol = study.protocolSection;
        const design = protocol.designModule;
        const eligibility = protocol.eligibilityModule;
        const oversight = protocol.oversightModule;

        updateStmt.run({
          nctId: row.nct_id,
          allocation: design?.designInfo?.allocation || null,
          interventionModel: design?.designInfo?.interventionModel || null,
          primaryPurpose: design?.designInfo?.primaryPurpose || null,
          masking: design?.designInfo?.maskingInfo?.masking || null,
          isFdaRegulatedDrug: oversight?.isFdaRegulatedDrug ? 1 : 0,
          isFdaRegulatedDevice: oversight?.isFdaRegulatedDevice ? 1 : 0,
          ageGroups: eligibility?.stdAges?.join(',') || null,
        });
      } catch (error) {
        // Skip studies with invalid JSON
        console.error(`Failed to backfill study ${row.nct_id}:`, error);
      }
    }
  }

  /**
   * Insert or update a study
   */
  upsertStudy(study: Study): void {
    const protocol = study.protocolSection;
    const identification = protocol.identificationModule;
    const status = protocol.statusModule;
    const description = protocol.descriptionModule;
    const conditions = protocol.conditionsModule;
    const design = protocol.designModule;
    const interventions = protocol.armsInterventionsModule;
    const eligibility = protocol.eligibilityModule;
    const locations = protocol.contactsLocationsModule;
    const sponsor = protocol.sponsorCollaboratorsModule;
    const oversight = protocol.oversightModule;

    // Prepare phase as comma-separated string
    const phase = design?.phases?.join(", ") || null;
    const ageGroups = eligibility?.stdAges?.join(",") || null;

    const stmt = this.db.prepare(`
      INSERT INTO studies (
        nct_id, brief_title, official_title, acronym,
        overall_status, study_type, phase,
        enrollment_count, enrollment_type,
        start_date, start_date_type,
        primary_completion_date, completion_date,
        last_update_posted, has_results,
        brief_summary, detailed_description,
        eligibility_criteria, sex, minimum_age, maximum_age, healthy_volunteers,
        lead_sponsor_name, lead_sponsor_class,
        allocation, intervention_model, primary_purpose, masking,
        is_fda_regulated_drug, is_fda_regulated_device, age_groups,
        raw_json, updated_at
      ) VALUES (
        @nctId, @briefTitle, @officialTitle, @acronym,
        @overallStatus, @studyType, @phase,
        @enrollmentCount, @enrollmentType,
        @startDate, @startDateType,
        @primaryCompletionDate, @completionDate,
        @lastUpdatePosted, @hasResults,
        @briefSummary, @detailedDescription,
        @eligibilityCriteria, @sex, @minimumAge, @maximumAge, @healthyVolunteers,
        @leadSponsorName, @leadSponsorClass,
        @allocation, @interventionModel, @primaryPurpose, @masking,
        @isFdaRegulatedDrug, @isFdaRegulatedDevice, @ageGroups,
        @rawJson, CURRENT_TIMESTAMP
      ) ON CONFLICT(nct_id) DO UPDATE SET
        brief_title = @briefTitle,
        official_title = @officialTitle,
        acronym = @acronym,
        overall_status = @overallStatus,
        study_type = @studyType,
        phase = @phase,
        enrollment_count = @enrollmentCount,
        enrollment_type = @enrollmentType,
        start_date = @startDate,
        start_date_type = @startDateType,
        primary_completion_date = @primaryCompletionDate,
        completion_date = @completionDate,
        last_update_posted = @lastUpdatePosted,
        has_results = @hasResults,
        brief_summary = @briefSummary,
        detailed_description = @detailedDescription,
        eligibility_criteria = @eligibilityCriteria,
        sex = @sex,
        minimum_age = @minimumAge,
        maximum_age = @maximumAge,
        healthy_volunteers = @healthyVolunteers,
        lead_sponsor_name = @leadSponsorName,
        lead_sponsor_class = @leadSponsorClass,
        allocation = @allocation,
        intervention_model = @interventionModel,
        primary_purpose = @primaryPurpose,
        masking = @masking,
        is_fda_regulated_drug = @isFdaRegulatedDrug,
        is_fda_regulated_device = @isFdaRegulatedDevice,
        age_groups = @ageGroups,
        raw_json = @rawJson,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run({
      nctId: identification.nctId,
      briefTitle: identification.briefTitle,
      officialTitle: identification.officialTitle || null,
      acronym: identification.acronym || null,
      overallStatus: status.overallStatus,
      studyType: design?.studyType || null,
      phase,
      enrollmentCount: design?.enrollmentInfo?.count || null,
      enrollmentType: design?.enrollmentInfo?.type || null,
      startDate: status.startDateStruct?.date || null,
      startDateType: status.startDateStruct?.type || null,
      primaryCompletionDate: status.primaryCompletionDateStruct?.date || null,
      completionDate: status.completionDateStruct?.date || null,
      lastUpdatePosted: status.lastUpdatePostDateStruct?.date || null,
      hasResults: study.hasResults ? 1 : 0,
      briefSummary: description?.briefSummary || null,
      detailedDescription: description?.detailedDescription || null,
      eligibilityCriteria: eligibility?.eligibilityCriteria || null,
      sex: eligibility?.sex || null,
      minimumAge: eligibility?.minimumAge || null,
      maximumAge: eligibility?.maximumAge || null,
      healthyVolunteers: eligibility?.healthyVolunteers ? 1 : 0,
      leadSponsorName: sponsor?.leadSponsor?.name || null,
      leadSponsorClass: sponsor?.leadSponsor?.class || null,
      allocation: design?.designInfo?.allocation || null,
      interventionModel: design?.designInfo?.interventionModel || null,
      primaryPurpose: design?.designInfo?.primaryPurpose || null,
      masking: design?.designInfo?.maskingInfo?.masking || null,
      isFdaRegulatedDrug: oversight?.isFdaRegulatedDrug ? 1 : 0,
      isFdaRegulatedDevice: oversight?.isFdaRegulatedDevice ? 1 : 0,
      ageGroups,
      rawJson: JSON.stringify(study),
    });

    const nctId = identification.nctId;

    // Insert conditions
    if (conditions?.conditions) {
      const deleteConditions = this.db.prepare(
        "DELETE FROM conditions WHERE nct_id = ?",
      );
      deleteConditions.run(nctId);

      const insertCondition = this.db.prepare(
        "INSERT OR IGNORE INTO conditions (nct_id, condition) VALUES (?, ?)",
      );

      for (const condition of conditions.conditions) {
        insertCondition.run(nctId, condition);
      }
    }

    // Insert keywords
    if (conditions?.keywords) {
      const deleteKeywords = this.db.prepare(
        "DELETE FROM keywords WHERE nct_id = ?",
      );
      deleteKeywords.run(nctId);

      const insertKeyword = this.db.prepare(
        "INSERT OR IGNORE INTO keywords (nct_id, keyword) VALUES (?, ?)",
      );

      for (const keyword of conditions.keywords) {
        insertKeyword.run(nctId, keyword);
      }
    }

    // Insert interventions
    if (interventions?.interventions) {
      const deleteInterventions = this.db.prepare(
        "DELETE FROM interventions WHERE nct_id = ?",
      );
      deleteInterventions.run(nctId);

      const insertIntervention = this.db.prepare(
        "INSERT OR IGNORE INTO interventions (nct_id, intervention_type, intervention_name, description) VALUES (?, ?, ?, ?)",
      );

      for (const intervention of interventions.interventions) {
        insertIntervention.run(
          nctId,
          intervention.type,
          intervention.name,
          intervention.description || null,
        );
      }
    }

    // Insert locations
    if (locations?.locations) {
      const deleteLocations = this.db.prepare(
        "DELETE FROM locations WHERE nct_id = ?",
      );
      deleteLocations.run(nctId);

      const insertLocation = this.db.prepare(
        "INSERT OR IGNORE INTO locations (nct_id, facility, city, state, country, status, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );

      for (const location of locations.locations) {
        insertLocation.run(
          nctId,
          location.facility || null,
          location.city || null,
          location.state || null,
          location.country || null,
          location.status || null,
          location.geoPoint?.lat || null,
          location.geoPoint?.lon || null,
        );
      }
    }

    // Insert primary outcomes
    const outcomes = protocol.outcomesModule;
    if (outcomes?.primaryOutcomes) {
      const deletePrimary = this.db.prepare(
        "DELETE FROM primary_outcomes WHERE nct_id = ?",
      );
      deletePrimary.run(nctId);

      const insertPrimary = this.db.prepare(
        "INSERT OR IGNORE INTO primary_outcomes (nct_id, measure, description, time_frame) VALUES (?, ?, ?, ?)",
      );

      for (const outcome of outcomes.primaryOutcomes) {
        insertPrimary.run(
          nctId,
          outcome.measure,
          outcome.description || null,
          outcome.timeFrame || null,
        );
      }
    }

    // Insert secondary outcomes
    if (outcomes?.secondaryOutcomes) {
      const deleteSecondary = this.db.prepare(
        "DELETE FROM secondary_outcomes WHERE nct_id = ?",
      );
      deleteSecondary.run(nctId);

      const insertSecondary = this.db.prepare(
        "INSERT OR IGNORE INTO secondary_outcomes (nct_id, measure, description, time_frame) VALUES (?, ?, ?, ?)",
      );

      for (const outcome of outcomes.secondaryOutcomes) {
        insertSecondary.run(
          nctId,
          outcome.measure,
          outcome.description || null,
          outcome.timeFrame || null,
        );
      }
    }
  }

  /**
   * Get study by NCT ID
   */
  getStudy(nctId: string): Study | null {
    const stmt = this.db.prepare(
      "SELECT raw_json FROM studies WHERE nct_id = ?",
    );
    const row = stmt.get(nctId) as { raw_json: string } | undefined;

    if (row) {
      return JSON.parse(row.raw_json);
    }

    return null;
  }

  /**
   * Full-text search
   */
  fullTextSearch(query: string, limit: number = 100): string[] {
    const stmt = this.db.prepare(`
      SELECT nct_id FROM studies_fts 
      WHERE studies_fts MATCH ? 
      ORDER BY rank 
      LIMIT ?
    `);

    const rows = stmt.all(query, limit) as { nct_id: string }[];
    return rows.map((row) => row.nct_id);
  }

  /**
   * Create search session
   */
  createSession(sessionId: string, searchParams: any, nctIds: string[]): void {
    const insertSession = this.db.prepare(`
      INSERT INTO search_sessions (session_id, search_params)
      VALUES (?, ?)
    `);

    insertSession.run(sessionId, JSON.stringify(searchParams));

    const insertResult = this.db.prepare(`
      INSERT INTO session_results (session_id, nct_id)
      VALUES (?, ?)
    `);

    for (const nctId of nctIds) {
      insertResult.run(sessionId, nctId);
    }
  }

  /**
   * Get session results
   */
  getSessionResults(sessionId: string): Study[] {
    // Update last accessed time
    const updateSession = this.db.prepare(`
      UPDATE search_sessions 
      SET last_accessed_at = CURRENT_TIMESTAMP 
      WHERE session_id = ?
    `);
    updateSession.run(sessionId);

    // Get studies
    const stmt = this.db.prepare(`
      SELECT s.raw_json 
      FROM studies s
      INNER JOIN session_results sr ON s.nct_id = sr.nct_id
      WHERE sr.session_id = ?
    `);

    const rows = stmt.all(sessionId) as { raw_json: string }[];
    return rows.map((row) => JSON.parse(row.raw_json));
  }

  /**
   * Update session results (for refinement)
   */
  updateSessionResults(sessionId: string, nctIds: string[]): void {
    // Delete existing results
    const deleteResults = this.db.prepare(`
      DELETE FROM session_results WHERE session_id = ?
    `);
    deleteResults.run(sessionId);

    // Insert new results
    const insertResult = this.db.prepare(`
      INSERT INTO session_results (session_id, nct_id)
      VALUES (?, ?)
    `);

    for (const nctId of nctIds) {
      insertResult.run(sessionId, nctId);
    }

    // Update last accessed
    const updateSession = this.db.prepare(`
      UPDATE search_sessions 
      SET last_accessed_at = CURRENT_TIMESTAMP 
      WHERE session_id = ?
    `);
    updateSession.run(sessionId);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Export singleton instance
export const db = new DatabaseManager();
