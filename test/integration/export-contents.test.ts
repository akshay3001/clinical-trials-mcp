import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Papa from "papaparse";
import {
  StudySchema,
  type AdditionalExportColumn,
  type Study,
} from "../../src/models/types.js";
import {
  exportToCSV,
  exportToJSON,
  exportToJSONL,
} from "../../src/utils/export.js";

const richStudy = StudySchema.parse({
  protocolSection: {
    identificationModule: {
      nctId: "NCT00000001",
      briefTitle: 'Trial "A", phase 1\nSecond line',
    },
    statusModule: {
      overallStatus: "RECRUITING",
      startDateStruct: { date: "2024-01-01" },
      completionDateStruct: { date: "2025-01-01" },
    },
    designModule: {
      studyType: "INTERVENTIONAL",
      phases: ["PHASE1", "PHASE2"],
      enrollmentInfo: { count: 0 },
      designInfo: {
        allocation: "RANDOMIZED",
        interventionModel: "PARALLEL",
        primaryPurpose: "TREATMENT",
      },
    },
    conditionsModule: { conditions: ["Diabetes", "Obesity"] },
    armsInterventionsModule: {
      interventions: [
        { type: "DRUG", name: 'Drug "A", B' },
        { type: "DEVICE", name: "Device C" },
      ],
    },
    outcomesModule: {
      primaryOutcomes: [{ measure: 'Score, "primary"\nAt baseline' }],
      secondaryOutcomes: [{ measure: "Quality" }, { measure: "Safety" }],
    },
    contactsLocationsModule: {
      locations: [
        {
          facility: "Clinic",
          city: "Boston",
          state: "MA",
          country: "United States",
        },
        { city: "Paris", country: "France" },
      ],
    },
    sponsorCollaboratorsModule: {
      leadSponsor: { name: 'Sponsor, "Inc"', class: "INDUSTRY" },
    },
    descriptionModule: { briefSummary: "First line\nSecond line" },
    eligibilityModule: {
      minimumAge: "18 Years",
      maximumAge: "65 Years",
      sex: "ALL",
      healthyVolunteers: false,
      stdAges: ["ADULT", "OLDER_ADULT"],
      eligibilityCriteria: 'Accept "A", exclude B\nOther rule',
    },
    oversightModule: { isFdaRegulatedDrug: false, isFdaRegulatedDevice: true },
  },
});
const missingStudy = StudySchema.parse({
  protocolSection: {
    identificationModule: {
      nctId: "NCT00000002",
      briefTitle: "Missing values",
    },
    statusModule: { overallStatus: "UNKNOWN" },
  },
});

// This record must name every optional column when the shared union changes.
const optionalValues = {
  MinAge: "18 Years",
  MaxAge: "65 Years",
  Sex: "ALL",
  SponsorType: "INDUSTRY",
  InterventionType: "DRUG; DEVICE",
  IsFDARegulatedDrug: "No",
  IsFDARegulatedDevice: "Yes",
  HealthyVolunteers: "No",
  AgeGroups: "ADULT, OLDER_ADULT",
  PrimaryPurpose: "TREATMENT",
  AllocationMethod: "RANDOMIZED",
  InterventionModel: "PARALLEL",
  StudyType: "INTERVENTIONAL",
} satisfies Record<AdditionalExportColumn, string>;

test("CSV round trips core and all optional columns with punctuation, missing values, zero and false", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clinical-trials-csv-"));
  const previousRoot = process.env.CLINICAL_TRIALS_EXPORTS_DIR;
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = root;
  try {
    const file = await exportToCSV(
      [richStudy, missingStudy],
      "contents.csv",
      Object.keys(optionalValues) as AdditionalExportColumn[],
    );
    const parsed = Papa.parse<Record<string, string>>(
      fs.readFileSync(file, "utf8"),
      { header: true },
    );
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.data, [
      {
        NCT_ID: "NCT00000001",
        Title: 'Trial "A", phase 1\nSecond line',
        Status: "RECRUITING",
        Phase: "PHASE1, PHASE2",
        Enrollment: "0",
        StartDate: "2024-01-01",
        CompletionDate: "2025-01-01",
        Conditions: "Diabetes; Obesity",
        Interventions: 'DRUG: Drug "A", B; DEVICE: Device C',
        PrimaryOutcomes: 'Score, "primary"\nAt baseline',
        SecondaryOutcomes: "Quality; Safety",
        Locations: "Clinic, Boston, MA, United States; Paris, France",
        Sponsor: 'Sponsor, "Inc"',
        Summary: "First line\nSecond line",
        EligibilityCriteria: 'Accept "A", exclude B\nOther rule',
        ...optionalValues,
      },
      {
        NCT_ID: "NCT00000002",
        Title: "Missing values",
        Status: "UNKNOWN",
        Phase: "BLANK",
        Enrollment: "BLANK",
        StartDate: "BLANK",
        CompletionDate: "BLANK",
        Conditions: "BLANK",
        Interventions: "BLANK",
        PrimaryOutcomes: "BLANK",
        SecondaryOutcomes: "BLANK",
        Locations: "BLANK",
        Sponsor: "BLANK",
        Summary: "BLANK",
        EligibilityCriteria: "BLANK",
        MinAge: "BLANK",
        MaxAge: "BLANK",
        Sex: "BLANK",
        SponsorType: "BLANK",
        InterventionType: "BLANK",
        IsFDARegulatedDrug: "BLANK",
        IsFDARegulatedDevice: "BLANK",
        HealthyVolunteers: "BLANK",
        AgeGroups: "BLANK",
        PrimaryPurpose: "BLANK",
        AllocationMethod: "BLANK",
        InterventionModel: "BLANK",
        StudyType: "BLANK",
      },
    ]);
    assert.deepEqual(parsed.meta.fields, Object.keys(parsed.data[0]));
  } finally {
    if (previousRoot === undefined)
      delete process.env.CLINICAL_TRIALS_EXPORTS_DIR;
    else process.env.CLINICAL_TRIALS_EXPORTS_DIR = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("JSON and JSONL preserve upstream records, absent values, and falsy values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clinical-trials-json-"));
  const previousRoot = process.env.CLINICAL_TRIALS_EXPORTS_DIR;
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = root;
  const fixture: Study = {
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000009",
        briefTitle: 'A, "B"\nC',
        officialTitle: "",
        acronym: "",
        secondaryIdInfos: [],
        nctIdAliases: [],
      },
      statusModule: { overallStatus: "COMPLETED" },
    },
    hasResults: false,
    extra: {
      zero: 0,
      no: false,
      missing: undefined,
      nil: null,
      text: "",
      list: [null, "", 0, false],
      empty: [],
    },
  };
  const expected = [
    {
      protocolSection: {
        identificationModule: {
          nctId: "NCT00000009",
          briefTitle: 'A, "B"\nC',
          officialTitle: "",
          acronym: "",
          secondaryIdInfos: [],
          nctIdAliases: [],
        },
        statusModule: { overallStatus: "COMPLETED" },
      },
      hasResults: false,
      extra: {
        zero: 0,
        no: false,
        nil: null,
        text: "",
        list: [null, "", 0, false],
        empty: [],
      },
    },
    {
      protocolSection: {
        identificationModule: {
          nctId: "NCT00000002",
          briefTitle: "Missing values",
        },
        statusModule: { overallStatus: "UNKNOWN" },
      },
    },
  ];
  try {
    const json = await exportToJSON([fixture, missingStudy], "contents.json");
    const jsonl = await exportToJSONL(
      [fixture, missingStudy],
      "contents.jsonl",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(json, "utf8")), expected);
    const lines = fs.readFileSync(jsonl, "utf8").split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      expected,
    );
    assert.equal(
      fixture.protocolSection.identificationModule.officialTitle,
      "",
    );
  } finally {
    if (previousRoot === undefined)
      delete process.env.CLINICAL_TRIALS_EXPORTS_DIR;
    else process.env.CLINICAL_TRIALS_EXPORTS_DIR = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
