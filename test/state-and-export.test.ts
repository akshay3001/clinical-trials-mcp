import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import type { FilterParams, Study } from "../src/models/types.js";

const originalWorkingDirectory = process.cwd();
const runtimeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "clinical-trials-state-test-"),
);
process.chdir(runtimeDirectory);

const [{ DatabaseManager, db }, exportModule, helperModule] = await Promise.all(
  [
    import("../src/db/database.js"),
    import("../src/utils/export.js"),
    import("../src/utils/helpers.js"),
  ],
);

const nctIdOf = (study: Study) =>
  study.protocolSection.identificationModule.nctId;

test.after(() => {
  db.close();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

test("uses opaque UUID session handles and preserves valid empty sessions", () => {
  const databasePath = path.join(runtimeDirectory, "isolated", "sessions.db");
  const database = new DatabaseManager(databasePath, 1_000);
  const sessionId = helperModule.generateSessionId();

  try {
    assert.match(
      sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    database.createSession(sessionId, { condition: "diabetes" }, []);
    assert.equal(database.sessionExists(sessionId), true);
    assert.equal(database.getSessionMetadata(sessionId)?.resultCount, 0);
    assert.deepEqual(database.getSessionResults(sessionId), []);
    assert.equal(database.updateSessionResults("missing", []), false);

    database.cleanupExpiredSessions(Date.now() + 2_000);
    assert.equal(database.sessionExists(sessionId), false);
  } finally {
    database.close();
  }
});

test("keeps API order in session results across refinement", () => {
  const databasePath = path.join(runtimeDirectory, "order", "sessions.db");
  const database = new DatabaseManager(databasePath);
  const apiOrder = ["NCT00000009", "NCT00000003", "NCT00000002"];

  try {
    for (const nctId of apiOrder) {
      database.upsertStudy({
        protocolSection: {
          identificationModule: { nctId, briefTitle: nctId },
          statusModule: { overallStatus: "RECRUITING" },
        },
      } as Study);
    }
    database.createSession("order-session", {}, apiOrder);
    assert.deepEqual(
      database.getSessionResults("order-session").map(nctIdOf),
      apiOrder,
    );

    database.updateSessionResults("order-session", [
      "NCT00000009",
      "NCT00000002",
    ]);
    assert.deepEqual(database.getSessionResults("order-session").map(nctIdOf), [
      "NCT00000009",
      "NCT00000002",
    ]);
  } finally {
    database.close();
  }
});

test("migrates studies and sessions created by older schema versions", () => {
  const databasePath = path.join(runtimeDirectory, "legacy", "sessions.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacyStudy = {
    protocolSection: {
      identificationModule: { nctId: "NCT00000009", briefTitle: "Legacy" },
      designModule: { designInfo: { allocation: "RANDOMIZED" } },
      oversightModule: { isFdaRegulatedDrug: true },
    },
  };
  const legacyDatabase = new Database(databasePath);
  // The studies table as created before the design and FDA columns existed.
  legacyDatabase.exec(`
    CREATE TABLE studies (
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
      raw_json TEXT NOT NULL,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE studies_fts USING fts5(
      nct_id UNINDEXED,
      brief_title,
      official_title,
      brief_summary,
      detailed_description,
      content=studies,
      content_rowid=rowid
    );
    CREATE TRIGGER studies_ai AFTER INSERT ON studies BEGIN
      INSERT INTO studies_fts(rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
      VALUES (new.rowid, new.nct_id, new.brief_title, new.official_title, new.brief_summary, new.detailed_description);
    END;
    -- The old update trigger left stale terms in the external content index.
    CREATE TRIGGER studies_au AFTER UPDATE ON studies BEGIN
      UPDATE studies_fts SET brief_title = new.brief_title WHERE rowid = new.rowid;
    END;
    CREATE TABLE search_sessions (
      session_id TEXT PRIMARY KEY,
      search_params TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO search_sessions (session_id, search_params)
    VALUES ('legacy-session', '{"condition":"diabetes"}');
    CREATE TABLE session_results (
      session_id TEXT NOT NULL REFERENCES search_sessions(session_id) ON DELETE CASCADE,
      nct_id TEXT NOT NULL REFERENCES studies(nct_id) ON DELETE CASCADE,
      PRIMARY KEY (session_id, nct_id)
    );
  `);
  const insertLegacyStudy = legacyDatabase.prepare(
    "INSERT INTO studies (nct_id, brief_title, raw_json) VALUES (?, ?, ?)",
  );
  insertLegacyStudy.run("NCT00000009", "Legacy", JSON.stringify(legacyStudy));
  insertLegacyStudy.run(
    "NCT00000002",
    "Second",
    JSON.stringify({
      protocolSection: {
        identificationModule: { nctId: "NCT00000002", briefTitle: "Second" },
      },
    }),
  );
  // Older versions inserted session rows in API order, not NCT ID order.
  const insertLegacyResult = legacyDatabase.prepare(
    "INSERT INTO session_results (session_id, nct_id) VALUES ('legacy-session', ?)",
  );
  insertLegacyResult.run("NCT00000009");
  insertLegacyResult.run("NCT00000002");
  legacyDatabase.close();

  const migratedDatabase = new DatabaseManager(databasePath);
  try {
    const metadata = migratedDatabase.getSessionMetadata("legacy-session");
    assert.ok(metadata);
    assert.deepEqual(metadata.searchParams, { condition: "diabetes" });
    assert.ok(Date.parse(metadata.expiresAt) > Date.now());
    assert.deepEqual(
      migratedDatabase.getSessionResults("legacy-session").map(nctIdOf),
      ["NCT00000009", "NCT00000002"],
    );

    migratedDatabase.upsertStudy({
      protocolSection: {
        ...legacyStudy.protocolSection,
        identificationModule: { nctId: "NCT00000009", briefTitle: "Renamed" },
        statusModule: { overallStatus: "RECRUITING" },
      },
    } as Study);
    assert.deepEqual(migratedDatabase.fullTextSearch("Legacy"), []);
    assert.deepEqual(migratedDatabase.fullTextSearch("Renamed"), [
      "NCT00000009",
    ]);
  } finally {
    migratedDatabase.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      reopenedDatabase
        .prepare(
          "SELECT allocation, is_fda_regulated_drug AS fdaDrug FROM studies WHERE nct_id = ?",
        )
        .get("NCT00000009"),
      { allocation: "RANDOMIZED", fdaDrug: 1 },
    );
    assert.equal(reopenedDatabase.pragma("user_version", { simple: true }), 2);
  } finally {
    reopenedDatabase.close();
  }
});

test("repairs stored flags from raw_json once, then skips the backfill", () => {
  const databasePath = path.join(runtimeDirectory, "backfill", "studies.db");
  const studyWith = (nctId: string, extra: object) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        statusModule: { overallStatus: "COMPLETED" },
        ...extra,
      },
    }) as Study;
  const database = new DatabaseManager(databasePath);
  database.upsertStudy(
    studyWith("NCT00000001", { designModule: { studyType: "OBSERVATIONAL" } }),
  );
  database.upsertStudy(
    studyWith("NCT00000002", {
      oversightModule: { isFdaRegulatedDrug: false },
    }),
  );
  database.close();

  // Simulate a database from before this repair: version 1, and 0 stored for
  // every flag, including the ones missing upstream.
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    UPDATE studies SET has_results = 0, healthy_volunteers = 0,
      is_fda_regulated_drug = 0, is_fda_regulated_device = 0;
    PRAGMA user_version = 1;
    CREATE TABLE backfilled (nct_id TEXT);
    CREATE TRIGGER count_backfill AFTER UPDATE ON studies BEGIN
      INSERT INTO backfilled VALUES (new.nct_id);
    END;
  `);
  legacyDatabase.close();

  const readBack = () => {
    const reader = new Database(databasePath, { readonly: true });
    try {
      return {
        version: reader.pragma("user_version", { simple: true }),
        backfilled: reader
          .prepare("SELECT COUNT(*) AS n FROM backfilled")
          .get(),
        flags: reader
          .prepare(
            `SELECT nct_id AS nctId, has_results AS hasResults,
              healthy_volunteers AS healthyVolunteers,
              is_fda_regulated_drug AS fdaDrug,
              is_fda_regulated_device AS fdaDevice
            FROM studies ORDER BY nct_id`,
          )
          .all(),
      };
    } finally {
      reader.close();
    }
  };

  new DatabaseManager(databasePath).close();
  const missing = {
    hasResults: null,
    healthyVolunteers: null,
    fdaDevice: null,
  };
  assert.deepEqual(readBack(), {
    version: 2,
    backfilled: { n: 2 },
    flags: [
      { nctId: "NCT00000001", ...missing, fdaDrug: null },
      { nctId: "NCT00000002", ...missing, fdaDrug: 0 },
    ],
  });

  new DatabaseManager(databasePath).close();
  assert.deepEqual(readBack().backfilled, { n: 2 });
});

test("stores studies atomically and skips related rows missing required fields", () => {
  const databasePath = path.join(runtimeDirectory, "atomic", "studies.db");
  const database = new DatabaseManager(databasePath);
  const nctId = "NCT00000010";

  try {
    database.upsertStudy({
      protocolSection: {
        identificationModule: { nctId, briefTitle: "Atomic" },
        statusModule: { overallStatus: "RECRUITING" },
        armsInterventionsModule: {
          interventions: [{ type: "DRUG", name: "Aspirin" }, { type: "DRUG" }],
        },
        outcomesModule: { primaryOutcomes: [{ description: "No measure" }] },
      },
    } as Study);
    assert.equal(
      database.getStudy(nctId)?.protocolSection.identificationModule.briefTitle,
      "Atomic",
    );

    // Force a failure in a related insert and check the core row rolls back.
    assert.throws(() =>
      database.upsertStudy({
        protocolSection: {
          identificationModule: { nctId: "NCT00000011", briefTitle: "Partial" },
          statusModule: { overallStatus: "RECRUITING" },
          conditionsModule: { conditions: [{}] },
        },
      } as unknown as Study),
    );
    assert.equal(database.getStudy("NCT00000011"), null);
  } finally {
    database.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      reopenedDatabase
        .prepare(
          "SELECT intervention_type AS type, intervention_name AS name FROM interventions WHERE nct_id = ?",
        )
        .all(nctId),
      [{ type: "DRUG", name: "Aspirin" }],
    );
  } finally {
    reopenedDatabase.close();
  }
});

test("confines exports, preserves JSON falsy values, and refuses overwrite", async () => {
  const exportRoot = path.join(runtimeDirectory, "safe-exports");
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = exportRoot;

  const studies = [{ zero: 0, enabled: false, empty: "" } as unknown as Study];
  const destination = await exportModule.exportToJSON(studies, "results.json");
  const exported = JSON.parse(fs.readFileSync(destination, "utf8")) as Array<{
    zero: number;
    enabled: boolean;
    empty: string;
  }>;

  assert.equal(
    path.dirname(destination),
    path.join(fs.realpathSync(exportRoot), "json"),
  );
  assert.deepEqual(exported, [{ zero: 0, enabled: false, empty: "BLANK" }]);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  await assert.rejects(
    exportModule.exportToJSON(studies, "results.json"),
    /Refusing to overwrite/,
  );
  assert.throws(
    () => exportModule.getExportPath("../escape.json", "json"),
    /must remain within/,
  );
  assert.throws(
    () =>
      exportModule.getExportPath(path.join(os.tmpdir(), "escape.json"), "json"),
    /must remain within/,
  );
});

test("rejects export symlink escapes and protects CSV consumers", async () => {
  const exportRoot = path.join(runtimeDirectory, "csv-exports");
  const outside = path.join(runtimeDirectory, "outside");
  fs.mkdirSync(exportRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(exportRoot, "linked"));
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = exportRoot;

  assert.throws(
    () => exportModule.getExportPath("linked/escape.csv", "csv"),
    /symbolic links/,
  );

  const study = {
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000001",
        briefTitle: '=HYPERLINK("https://example.test")',
      },
      statusModule: { overallStatus: "RECRUITING" },
    },
  } as Study;
  const destination = await exportModule.exportToCSV([study], "safe.csv");
  assert.match(fs.readFileSync(destination, "utf8"), /'=HYPERLINK/);
});

test("omits a missing intervention type or name from the CSV", async () => {
  const studyWithInterventions = (
    nctId: string,
    interventions: Array<{ type?: string; name?: string }>,
  ) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        statusModule: { overallStatus: "RECRUITING" },
        armsInterventionsModule: { interventions },
      },
    }) as Study;

  const destination = await exportModule.exportToCSV(
    [
      studyWithInterventions("NCT00000021", [
        { name: "Aspirin" },
        { type: "DRUG" },
        { type: "DEVICE", name: "Stent" },
      ]),
      studyWithInterventions("NCT00000022", [{}]),
    ],
    "interventions.csv",
  );
  const [, partial, empty] = fs
    .readFileSync(destination, "utf8")
    .trim()
    .split(/\r?\n/);

  assert.doesNotMatch(partial, /undefined/);
  assert.match(partial, /,Aspirin; DRUG; DEVICE: Stent,/);
  assert.match(empty, /^NCT00000022,(?:[^,]*,){7}BLANK,/);
});

test("compares refinement age bounds numerically across units", () => {
  const studyWithAges = (
    nctId: string,
    minimumAge?: string,
    maximumAge?: string,
  ) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        eligibilityModule: { minimumAge, maximumAge },
      },
    }) as Study;
  const studies = [
    studyWithAges("NCT00000001", "9 Years", "100 Years"),
    studyWithAges("NCT00000002", "18 Years", "75 Years"),
    studyWithAges("NCT00000003", "216 Months", "74 Years"),
    studyWithAges("NCT00000004"),
  ];
  const matchingIds = (filters: { minAge?: string; maxAge?: string }) =>
    helperModule
      .filterStudies(studies, filters)
      .map((study) => study.protocolSection.identificationModule.nctId);

  assert.deepEqual(matchingIds({ minAge: "18 Years" }), [
    "NCT00000002",
    "NCT00000003",
  ]);
  assert.deepEqual(matchingIds({ maxAge: "75 Years" }), [
    "NCT00000002",
    "NCT00000003",
  ]);
  assert.throws(() => matchingIds({ minAge: "adult" }), /minAge/);
});

test("patientAge keeps studies a patient of that age can join", () => {
  const studyWithAges = (
    nctId: string,
    minimumAge?: string,
    maximumAge?: string,
  ) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        eligibilityModule: { minimumAge, maximumAge },
      },
    }) as Study;
  const studies = [
    studyWithAges("NCT00000001", "18 Years"),
    studyWithAges("NCT00000002", "18 Years", "65 Years"),
    studyWithAges("NCT00000003", "18 Years", "780 Months"),
    studyWithAges("NCT00000004", undefined, "17 Years"),
    studyWithAges("NCT00000005"),
  ];
  const matchingIds = (patientAge: string) =>
    helperModule
      .filterStudies(studies, { patientAge })
      .map((study) => study.protocolSection.identificationModule.nctId);

  assert.deepEqual(matchingIds("65 Years"), [
    "NCT00000001",
    "NCT00000002",
    "NCT00000003",
    "NCT00000005",
  ]);
  assert.deepEqual(matchingIds("70 Years"), ["NCT00000001", "NCT00000005"]);
  assert.deepEqual(matchingIds("10 Years"), ["NCT00000004", "NCT00000005"]);
  assert.throws(() => matchingIds("elderly"), /patientAge/);
});

test("excludes studies with missing values when numeric or date bounds are set", () => {
  const studyWith = (nctId: string, enrollment?: number, startDate?: string) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        statusModule: {
          overallStatus: "RECRUITING",
          startDateStruct: startDate ? { date: startDate } : undefined,
        },
        designModule: {
          enrollmentInfo:
            enrollment === undefined ? undefined : { count: enrollment },
        },
      },
    }) as Study;
  const studies = [
    studyWith("NCT00000001", 150, "2021-05-10"),
    studyWith("NCT00000002"),
    studyWith("NCT00000003", 50, "2020"),
    studyWith("NCT00000004", 100, "2020-02"),
  ];
  const matchingIds = (filters: FilterParams) =>
    helperModule
      .filterStudies(studies, filters)
      .map((study) => study.protocolSection.identificationModule.nctId);

  assert.deepEqual(matchingIds({ enrollmentMin: 100 }), [
    "NCT00000001",
    "NCT00000004",
  ]);
  assert.deepEqual(matchingIds({ enrollmentMax: 100 }), [
    "NCT00000003",
    "NCT00000004",
  ]);
  assert.deepEqual(matchingIds({ startDateAfter: "2020-01-01" }), [
    "NCT00000001",
    "NCT00000003",
    "NCT00000004",
  ]);
  // A partial date passes only if its whole period is inside the bounds.
  assert.deepEqual(matchingIds({ startDateAfter: "2020-02-01" }), [
    "NCT00000001",
    "NCT00000004",
  ]);
  assert.deepEqual(matchingIds({ startDateBefore: "2020-02-28" }), []);
  assert.deepEqual(matchingIds({ startDateBefore: "2020-02-29" }), [
    "NCT00000004",
  ]);
});

test("shows and stores an enrollment count of 0", () => {
  const study = {
    protocolSection: {
      identificationModule: { nctId: "NCT00000012", briefTitle: "Withdrawn" },
      statusModule: { overallStatus: "WITHDRAWN" },
      designModule: { enrollmentInfo: { count: 0, type: "ACTUAL" } },
    },
  } as Study;

  assert.match(
    helperModule.formatStudySummary(study),
    /\*\*Enrollment:\*\* 0 participants \(ACTUAL\)/,
  );
  assert.match(helperModule.formatStudyList([study]), /\| Enrollment: 0\n/);

  const databasePath = path.join(runtimeDirectory, "enrollment", "studies.db");
  const database = new DatabaseManager(databasePath);
  try {
    database.upsertStudy(study);
  } finally {
    database.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      reopenedDatabase
        .prepare("SELECT enrollment_count FROM studies WHERE nct_id = ?")
        .get("NCT00000012"),
      { enrollment_count: 0 },
    );
  } finally {
    reopenedDatabase.close();
  }
});

test("stores location coordinates of 0", () => {
  const study = {
    protocolSection: {
      identificationModule: { nctId: "NCT00000013", briefTitle: "Equator" },
      statusModule: { overallStatus: "RECRUITING" },
      contactsLocationsModule: {
        locations: [{ facility: "Null Island", geoPoint: { lat: 0, lon: 0 } }],
      },
    },
  } as Study;

  const databasePath = path.join(runtimeDirectory, "locations", "studies.db");
  const database = new DatabaseManager(databasePath);
  try {
    database.upsertStudy(study);
  } finally {
    database.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(
      reopenedDatabase
        .prepare("SELECT latitude, longitude FROM locations WHERE nct_id = ?")
        .get("NCT00000013"),
      { latitude: 0, longitude: 0 },
    );
  } finally {
    reopenedDatabase.close();
  }
});

test("stores upstream booleans as 1, 0, or NULL when missing", () => {
  const flagStudy = (nctId: string, value?: boolean) =>
    ({
      hasResults: value,
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        statusModule: { overallStatus: "RECRUITING" },
        eligibilityModule: { healthyVolunteers: value },
        oversightModule: {
          isFdaRegulatedDrug: value,
          isFdaRegulatedDevice: value,
        },
      },
    }) as Study;

  const databasePath = path.join(runtimeDirectory, "booleans", "studies.db");
  const database = new DatabaseManager(databasePath);
  try {
    database.upsertStudy(flagStudy("NCT00000021", true));
    database.upsertStudy(flagStudy("NCT00000022", false));
    database.upsertStudy(flagStudy("NCT00000023"));
  } finally {
    database.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    const flags = reopenedDatabase
      .prepare(
        `SELECT has_results, healthy_volunteers, is_fda_regulated_drug,
          is_fda_regulated_device FROM studies ORDER BY nct_id`,
      )
      .all()
      .map((row) => Object.values(row as Record<string, unknown>));
    assert.deepEqual(flags, [
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [null, null, null, null],
    ]);
  } finally {
    reopenedDatabase.close();
  }
});

test("treats one false FDA flag as not regulated and both missing as unknown", () => {
  const studyWithOversight = (
    nctId: string,
    oversightModule?: { isFdaRegulatedDrug?: boolean },
  ) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        oversightModule,
      },
    }) as Study;
  const studies = [
    studyWithOversight("NCT00000001", { isFdaRegulatedDrug: true }),
    studyWithOversight("NCT00000002", { isFdaRegulatedDrug: false }),
    studyWithOversight("NCT00000003", {}),
    studyWithOversight("NCT00000004"),
  ];
  const matchingIds = (fdaRegulated: boolean) =>
    helperModule
      .filterStudies(studies, { fdaRegulated })
      .map((study) => study.protocolSection.identificationModule.nctId);

  assert.deepEqual(matchingIds(true), ["NCT00000001"]);
  assert.deepEqual(matchingIds(false), ["NCT00000002"]);
});

test("removes related rows when an upstream module disappears", () => {
  const nctId = "NCT00000014";
  const databasePath = path.join(runtimeDirectory, "stale", "studies.db");
  const database = new DatabaseManager(databasePath);
  try {
    database.upsertStudy({
      protocolSection: {
        identificationModule: { nctId, briefTitle: "Full" },
        statusModule: { overallStatus: "RECRUITING" },
        conditionsModule: { conditions: ["Asthma"], keywords: ["lung"] },
        armsInterventionsModule: {
          interventions: [{ type: "DRUG", name: "Aspirin" }],
        },
        contactsLocationsModule: { locations: [{ facility: "Clinic" }] },
        outcomesModule: {
          primaryOutcomes: [{ measure: "Primary" }],
          secondaryOutcomes: [{ measure: "Secondary" }],
        },
      },
    } as Study);
    database.upsertStudy({
      protocolSection: {
        identificationModule: { nctId, briefTitle: "Bare" },
        statusModule: { overallStatus: "RECRUITING" },
      },
    } as Study);
  } finally {
    database.close();
  }

  const reopenedDatabase = new Database(databasePath, { readonly: true });
  try {
    for (const table of [
      "conditions",
      "keywords",
      "interventions",
      "locations",
      "primary_outcomes",
      "secondary_outcomes",
    ]) {
      assert.deepEqual(
        reopenedDatabase
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE nct_id = ?`)
          .get(nctId),
        { count: 0 },
        table,
      );
    }
  } finally {
    reopenedDatabase.close();
  }
});

test("matches PATIENT_REGISTRY by the patientRegistry flag", () => {
  const studyWithDesign = (
    nctId: string,
    studyType: string,
    patientRegistry?: boolean,
  ) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        designModule: { studyType, patientRegistry },
      },
    }) as Study;
  const studies = [
    studyWithDesign("NCT00000001", "OBSERVATIONAL", true),
    studyWithDesign("NCT00000002", "OBSERVATIONAL", false),
    studyWithDesign("NCT00000003", "INTERVENTIONAL"),
  ];
  const matchingIds = (studyType: FilterParams["studyType"]) =>
    helperModule
      .filterStudies(studies, { studyType })
      .map((study) => study.protocolSection.identificationModule.nctId);

  assert.deepEqual(matchingIds("PATIENT_REGISTRY"), ["NCT00000001"]);
  assert.deepEqual(matchingIds("OBSERVATIONAL"), [
    "NCT00000001",
    "NCT00000002",
  ]);
});
