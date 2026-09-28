import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FilterParams, Study } from "../src/models/types.js";
import { filterStudies } from "../src/utils/helpers.js";

type StudyMutation = (study: Study) => void;

function matchingStudy(nctId: string): Study {
  return {
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Study ${nctId}` },
      statusModule: {
        overallStatus: "RECRUITING",
        startDateStruct: { date: "2024-01-15" },
        completionDateStruct: { date: "2025-01-15" },
      },
      conditionsModule: { keywords: ["Precision Biomarker", "Oncology"] },
      designModule: {
        studyType: "interventional",
        phases: ["PHASE1"],
        enrollmentInfo: { count: 100 },
        designInfo: {
          allocation: "Randomized",
          interventionModel: "Parallel",
          primaryPurpose: "Treatment",
          maskingInfo: { masking: "Double" },
        },
      },
      armsInterventionsModule: { interventions: [{ type: "Drug" }] },
      eligibilityModule: {
        sex: "female",
        healthyVolunteers: true,
        minimumAge: "216 Months",
        maximumAge: "780 Months",
        stdAges: ["Adult", "Child"],
      },
      contactsLocationsModule: {
        locations: [
          { country: "United States", state: "New York", city: "Albany" },
        ],
      },
      sponsorCollaboratorsModule: { leadSponsor: { class: "Industry" } },
      oversightModule: {
        isFdaRegulatedDrug: true,
        isFdaRegulatedDevice: false,
      },
    },
    hasResults: true,
  } as Study;
}

function changedStudy(nctId: string, change: StudyMutation): Study {
  const study = structuredClone(matchingStudy(nctId));
  change(study);
  return study;
}

function matchingIds(studies: Study[], filters: FilterParams): string[] {
  return filterStudies(studies, filters).map(
    (study) => study.protocolSection.identificationModule.nctId,
  );
}

interface FilterCase {
  name: string;
  filters: FilterParams;
  matching?: StudyMutation;
  reject: StudyMutation;
  missing: StudyMutation;
}

const filterCases: FilterCase[] = [
  {
    name: "phase accepts human-readable input and API phase enums",
    filters: { phase: "Phase 1" },
    reject: (study) => {
      study.protocolSection.designModule!.phases = ["PHASE2"];
    },
    missing: (study) => {
      study.protocolSection.designModule = undefined;
    },
  },
  {
    name: "locationCountry is case-insensitive substring matching",
    filters: { locationCountry: "united states" },
    reject: (study) => {
      study.protocolSection.contactsLocationsModule!.locations[0].country =
        "Canada";
    },
    missing: (study) => {
      study.protocolSection.contactsLocationsModule = undefined;
    },
  },
  {
    name: "locationState is case-insensitive substring matching",
    filters: { locationState: "new york" },
    reject: (study) => {
      study.protocolSection.contactsLocationsModule!.locations[0].state =
        "California";
    },
    missing: (study) => {
      study.protocolSection.contactsLocationsModule = undefined;
    },
  },
  {
    name: "locationCity is case-insensitive substring matching",
    filters: { locationCity: "albany" },
    reject: (study) => {
      study.protocolSection.contactsLocationsModule!.locations[0].city =
        "Buffalo";
    },
    missing: (study) => {
      study.protocolSection.contactsLocationsModule = undefined;
    },
  },
  {
    name: "enrollmentMin is inclusive and requires enrollment data",
    filters: { enrollmentMin: 100 },
    reject: (study) => {
      study.protocolSection.designModule!.enrollmentInfo!.count = 99;
    },
    missing: (study) => {
      study.protocolSection.designModule!.enrollmentInfo = undefined;
    },
  },
  {
    name: "enrollmentMax is inclusive and requires enrollment data",
    filters: { enrollmentMax: 100 },
    reject: (study) => {
      study.protocolSection.designModule!.enrollmentInfo!.count = 101;
    },
    missing: (study) => {
      study.protocolSection.designModule!.enrollmentInfo = undefined;
    },
  },
  {
    name: "startDateAfter is inclusive and requires a start date",
    filters: { startDateAfter: "2024-01-15" },
    reject: (study) => {
      study.protocolSection.statusModule.startDateStruct!.date = "2024-01-14";
    },
    missing: (study) => {
      study.protocolSection.statusModule.startDateStruct = undefined;
    },
  },
  {
    name: "startDateBefore is inclusive and requires a start date",
    filters: { startDateBefore: "2024-01-15" },
    reject: (study) => {
      study.protocolSection.statusModule.startDateStruct!.date = "2024-01-16";
    },
    missing: (study) => {
      study.protocolSection.statusModule.startDateStruct = undefined;
    },
  },
  {
    name: "completionDateAfter is inclusive and requires a completion date",
    filters: { completionDateAfter: "2025-01-15" },
    reject: (study) => {
      study.protocolSection.statusModule.completionDateStruct!.date =
        "2025-01-14";
    },
    missing: (study) => {
      study.protocolSection.statusModule.completionDateStruct = undefined;
    },
  },
  {
    name: "completionDateBefore is inclusive and requires a completion date",
    filters: { completionDateBefore: "2025-01-15" },
    reject: (study) => {
      study.protocolSection.statusModule.completionDateStruct!.date =
        "2025-01-16";
    },
    missing: (study) => {
      study.protocolSection.statusModule.completionDateStruct = undefined;
    },
  },
  {
    name: "interventionType is case-insensitive exact matching",
    filters: { interventionType: "drug" },
    reject: (study) => {
      study.protocolSection.armsInterventionsModule!.interventions[0].type =
        "Device";
    },
    missing: (study) => {
      study.protocolSection.armsInterventionsModule = undefined;
    },
  },
  {
    name: "hasResults matches booleans and excludes missing data",
    filters: { hasResults: true },
    reject: (study) => {
      study.hasResults = false;
    },
    missing: (study) => {
      study.hasResults = undefined;
    },
  },
  {
    name: "studyType is case-insensitive exact matching",
    filters: { studyType: "INTERVENTIONAL" },
    reject: (study) => {
      study.protocolSection.designModule!.studyType = "OBSERVATIONAL";
    },
    missing: (study) => {
      study.protocolSection.designModule = undefined;
    },
  },
  {
    name: "sex is case-insensitive exact matching",
    filters: { sex: "FEMALE" },
    reject: (study) => {
      study.protocolSection.eligibilityModule!.sex = "MALE";
    },
    missing: (study) => {
      study.protocolSection.eligibilityModule = undefined;
    },
  },
  {
    name: "healthyVolunteers matches booleans and excludes missing data",
    filters: { healthyVolunteers: true },
    reject: (study) => {
      study.protocolSection.eligibilityModule!.healthyVolunteers = false;
    },
    missing: (study) => {
      study.protocolSection.eligibilityModule = undefined;
    },
  },
  {
    name: "sponsorClass is case-insensitive exact matching",
    filters: { sponsorClass: "INDUSTRY" },
    reject: (study) => {
      study.protocolSection.sponsorCollaboratorsModule!.leadSponsor!.class =
        "NIH";
    },
    missing: (study) => {
      study.protocolSection.sponsorCollaboratorsModule = undefined;
    },
  },
  {
    name: "allocation normalizes spaced source values",
    filters: { allocation: "NON_RANDOMIZED" },
    matching: (study) => {
      study.protocolSection.designModule!.designInfo!.allocation =
        "Non Randomized";
    },
    reject: (study) => {
      study.protocolSection.designModule!.designInfo!.allocation = "Randomized";
    },
    missing: (study) => {
      study.protocolSection.designModule!.designInfo = undefined;
    },
  },
  {
    name: "interventionModel normalizes spaced source values",
    filters: { interventionModel: "SINGLE_GROUP" },
    matching: (study) => {
      study.protocolSection.designModule!.designInfo!.interventionModel =
        "Single Group";
    },
    reject: (study) => {
      study.protocolSection.designModule!.designInfo!.interventionModel =
        "Parallel";
    },
    missing: (study) => {
      study.protocolSection.designModule!.designInfo = undefined;
    },
  },
  {
    name: "primaryPurpose normalizes spaces and case",
    filters: { primaryPurpose: "TREATMENT" },
    reject: (study) => {
      study.protocolSection.designModule!.designInfo!.primaryPurpose =
        "PREVENTION";
    },
    missing: (study) => {
      study.protocolSection.designModule!.designInfo = undefined;
    },
  },
  {
    name: "minAge compares normalized age units inclusively",
    filters: { minAge: "18 Years" },
    reject: (study) => {
      study.protocolSection.eligibilityModule!.minimumAge = "17 Years";
    },
    missing: (study) => {
      study.protocolSection.eligibilityModule!.minimumAge = "N/A";
    },
  },
  {
    name: "maxAge compares normalized age units inclusively",
    filters: { maxAge: "65 Years" },
    reject: (study) => {
      study.protocolSection.eligibilityModule!.maximumAge = "66 Years";
    },
    missing: (study) => {
      study.protocolSection.eligibilityModule!.maximumAge = "N/A";
    },
  },
  {
    name: "ageGroups performs case-insensitive any-of array matching",
    filters: { ageGroups: ["CHILD", "OLDER_ADULT"] },
    reject: (study) => {
      study.protocolSection.eligibilityModule!.stdAges = ["ADULT"];
    },
    missing: (study) => {
      study.protocolSection.eligibilityModule = undefined;
    },
  },
  {
    name: "masking is case-insensitive exact matching",
    filters: { masking: "DOUBLE" },
    reject: (study) => {
      study.protocolSection.designModule!.designInfo!.maskingInfo!.masking =
        "SINGLE";
    },
    missing: (study) => {
      study.protocolSection.designModule!.designInfo = undefined;
    },
  },
  {
    name: "fdaRegulated matches either regulated drug or device",
    filters: { fdaRegulated: true },
    reject: (study) => {
      study.protocolSection.oversightModule!.isFdaRegulatedDrug = false;
    },
    missing: (study) => {
      study.protocolSection.oversightModule = undefined;
    },
  },
  {
    name: "keyword is a case-insensitive substring search",
    filters: { keyword: "biomark" },
    reject: (study) => {
      study.protocolSection.conditionsModule!.keywords = ["Safety"];
    },
    missing: (study) => {
      study.protocolSection.conditionsModule = undefined;
    },
  },
];

test("refinement filters cover matching, non-matching, and missing data", () => {
  for (const [index, filterCase] of filterCases.entries()) {
    const matching = changedStudy(
      `NCT${String(index + 1).padStart(8, "0")}`,
      filterCase.matching ?? (() => undefined),
    );
    const rejected = changedStudy(
      `NCT${String(index + 101).padStart(8, "0")}`,
      filterCase.reject,
    );
    const missing = changedStudy(
      `NCT${String(index + 201).padStart(8, "0")}`,
      filterCase.missing,
    );

    assert.deepEqual(
      matchingIds([matching, rejected, missing], filterCase.filters),
      [matching.protocolSection.identificationModule.nctId],
      filterCase.name,
    );
  }
});

test("boolean filters also retain matching false values", () => {
  const noResults = changedStudy("NCT00001001", (study) => {
    study.hasResults = false;
  });
  const noHealthyVolunteers = changedStudy("NCT00001002", (study) => {
    study.protocolSection.eligibilityModule!.healthyVolunteers = false;
  });
  const notFdaRegulated = changedStudy("NCT00001003", (study) => {
    study.protocolSection.oversightModule!.isFdaRegulatedDrug = false;
  });

  assert.deepEqual(matchingIds([noResults], { hasResults: false }), [
    "NCT00001001",
  ]);
  assert.deepEqual(
    matchingIds([noHealthyVolunteers], { healthyVolunteers: false }),
    ["NCT00001002"],
  );
  assert.deepEqual(matchingIds([notFdaRegulated], { fdaRegulated: false }), [
    "NCT00001003",
  ]);
});

test("phase filtering handles early-phase and not-applicable aliases", () => {
  const earlyPhase = changedStudy("NCT00001004", (study) => {
    study.protocolSection.designModule!.phases = ["EARLY_PHASE1"];
  });
  const notApplicable = changedStudy("NCT00001005", (study) => {
    study.protocolSection.designModule!.phases = ["NA"];
  });

  assert.deepEqual(matchingIds([earlyPhase], { phase: "Phase 1" }), [
    "NCT00001004",
  ]);
  assert.deepEqual(matchingIds([notApplicable], { phase: "Not Applicable" }), [
    "NCT00001005",
  ]);
});

const originalWorkingDirectory = process.cwd();
const runtimeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "clinical-trials-refinement-test-"),
);
process.chdir(runtimeDirectory);
const { DatabaseManager, db } = await import("../src/db/database.js");

test.after(() => {
  db.close();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

test("successive refinements use and replace the current session result set", () => {
  const database = new DatabaseManager(
    path.join(runtimeDirectory, "sessions.db"),
  );
  const interventionalDouble = matchingStudy("NCT00002001");
  const interventionalSingle = changedStudy("NCT00002002", (study) => {
    study.protocolSection.designModule!.designInfo!.maskingInfo!.masking =
      "SINGLE";
  });
  const observationalDouble = changedStudy("NCT00002003", (study) => {
    study.protocolSection.designModule!.studyType = "OBSERVATIONAL";
  });
  const sessionId = "refinement-session";

  try {
    for (const study of [
      interventionalDouble,
      interventionalSingle,
      observationalDouble,
    ]) {
      database.upsertStudy(study);
    }
    database.createSession(sessionId, {}, [
      "NCT00002001",
      "NCT00002002",
      "NCT00002003",
    ]);

    const interventional = filterStudies(
      database.getSessionResults(sessionId),
      {
        studyType: "INTERVENTIONAL",
      },
    );
    assert.equal(
      database.updateSessionResults(
        sessionId,
        interventional.map(
          (study) => study.protocolSection.identificationModule.nctId,
        ),
      ),
      true,
    );

    const doubleBlind = filterStudies(database.getSessionResults(sessionId), {
      masking: "DOUBLE",
    });
    assert.deepEqual(
      doubleBlind.map(
        (study) => study.protocolSection.identificationModule.nctId,
      ),
      ["NCT00002001"],
    );
  } finally {
    database.close();
  }
});
