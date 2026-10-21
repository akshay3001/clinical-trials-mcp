import assert from "node:assert/strict";
import test from "node:test";
import { StudySchema, type FilterParams } from "../../src/models/types.js";
import { filterStudies } from "../../src/utils/helpers.js";

const studies = [
  StudySchema.parse({
    hasResults: false,
    protocolSection: {
      identificationModule: { nctId: "NCT00000001", briefTitle: "Drug study" },
      statusModule: {
        overallStatus: "RECRUITING",
        startDateStruct: { date: "2024-02-29" },
      },
      designModule: {
        studyType: "interventional",
        enrollmentInfo: { count: 0 },
        designInfo: {
          allocation: "Non Randomized",
          interventionModel: "Single Group",
          primaryPurpose: "Supportive Care",
          maskingInfo: { masking: "double" },
        },
      },
      eligibilityModule: {
        sex: "female",
        healthyVolunteers: false,
        stdAges: ["child", "adult"],
      },
      sponsorCollaboratorsModule: { leadSponsor: { class: "industry" } },
      conditionsModule: { keywords: ["Blood glucose", "Insulin"] },
      armsInterventionsModule: {
        interventions: [{ type: "drug" }, { type: "BEHAVIORAL" }],
      },
      oversightModule: {
        isFdaRegulatedDrug: false,
        isFdaRegulatedDevice: true,
      },
    },
  }),
  StudySchema.parse({
    hasResults: true,
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000002",
        briefTitle: "Device study",
      },
      statusModule: {
        overallStatus: "COMPLETED",
        startDateStruct: { date: "2024-03" },
      },
      designModule: {
        studyType: "OBSERVATIONAL",
        enrollmentInfo: { count: 100 },
        designInfo: {
          interventionModel: "PARALLEL",
          primaryPurpose: "TREATMENT",
          maskingInfo: { masking: "NONE" },
        },
      },
      eligibilityModule: {
        sex: "ALL",
        healthyVolunteers: true,
        stdAges: ["OLDER_ADULT"],
      },
      sponsorCollaboratorsModule: { leadSponsor: { class: "NIH" } },
      armsInterventionsModule: { interventions: [{ type: "DEVICE" }] },
      conditionsModule: { keywords: ["Heart health"] },
    },
  }),
  StudySchema.parse({
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000003",
        briefTitle: "Missing modules",
      },
      statusModule: { overallStatus: "UNKNOWN" },
    },
  }),
  StudySchema.parse({
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000004",
        briefTitle: "Empty modules",
      },
      statusModule: {
        overallStatus: "UNKNOWN",
        startDateStruct: { date: "unknown" },
      },
      designModule: {},
      eligibilityModule: {},
      armsInterventionsModule: {},
      conditionsModule: {},
    },
  }),
];

const cases: { name: string; filters: FilterParams; ids: string[] }[] = [
  {
    name: "intervention type uses any intervention and ignores case",
    filters: { interventionType: "DRUG" },
    ids: ["NCT00000001"],
  },
  {
    name: "results false excludes absent results",
    filters: { hasResults: false },
    ids: ["NCT00000001"],
  },
  { name: "results true", filters: { hasResults: true }, ids: ["NCT00000002"] },
  {
    name: "study type ignores upstream case",
    filters: { studyType: "INTERVENTIONAL" },
    ids: ["NCT00000001"],
  },
  {
    name: "sex ignores upstream case",
    filters: { sex: "FEMALE" },
    ids: ["NCT00000001"],
  },
  {
    name: "ALL sex is an exact category",
    filters: { sex: "ALL" },
    ids: ["NCT00000002"],
  },
  {
    name: "healthy volunteers false excludes unknown",
    filters: { healthyVolunteers: false },
    ids: ["NCT00000001"],
  },
  {
    name: "healthy volunteers true",
    filters: { healthyVolunteers: true },
    ids: ["NCT00000002"],
  },
  {
    name: "sponsor class ignores upstream case",
    filters: { sponsorClass: "INDUSTRY" },
    ids: ["NCT00000001"],
  },
  {
    name: "allocation normalizes spaces",
    filters: { allocation: "NON_RANDOMIZED" },
    ids: ["NCT00000001"],
  },
  {
    name: "intervention model normalizes spaces",
    filters: { interventionModel: "SINGLE_GROUP" },
    ids: ["NCT00000001"],
  },
  {
    name: "primary purpose normalizes spaces",
    filters: { primaryPurpose: "SUPPORTIVE_CARE" },
    ids: ["NCT00000001"],
  },
  {
    name: "age groups use any requested group",
    filters: { ageGroups: ["CHILD", "OLDER_ADULT"] },
    ids: ["NCT00000001", "NCT00000002"],
  },
  {
    name: "age group ignores upstream case",
    filters: { ageGroups: ["ADULT"] },
    ids: ["NCT00000001"],
  },
  {
    name: "empty age groups impose no restriction",
    filters: { ageGroups: [] },
    ids: ["NCT00000001", "NCT00000002", "NCT00000003", "NCT00000004"],
  },
  {
    name: "masking ignores upstream case",
    filters: { masking: "DOUBLE" },
    ids: ["NCT00000001"],
  },
  {
    name: "a true device flag takes priority over false drug flag",
    filters: { fdaRegulated: true },
    ids: ["NCT00000001"],
  },
  {
    name: "keyword uses case insensitive substring",
    filters: { keyword: "GLUCO" },
    ids: ["NCT00000001"],
  },
  {
    name: "keyword does not match title or missing arrays",
    filters: { keyword: "study" },
    ids: [],
  },
  {
    name: "zero is an inclusive enrollment bound",
    filters: { enrollmentMin: 0, enrollmentMax: 0 },
    ids: ["NCT00000001"],
  },
  {
    name: "date bounds include an exact day",
    filters: { startDateAfter: "2024-02-29", startDateBefore: "2024-02-29" },
    ids: ["NCT00000001"],
  },
  {
    name: "date bounds include a complete month",
    filters: { startDateAfter: "2024-03-01", startDateBefore: "2024-03-31" },
    ids: ["NCT00000002"],
  },
  {
    name: "partial month cannot overlap a bound",
    filters: { startDateAfter: "2024-03-02" },
    ids: [],
  },
  {
    name: "combined filters require all criteria",
    filters: {
      interventionType: "BEHAVIORAL",
      sex: "FEMALE",
      hasResults: false,
      enrollmentMax: 0,
      ageGroups: ["ADULT"],
      keyword: "insulin",
    },
    ids: ["NCT00000001"],
  },
  {
    name: "combined filters can exclude separate matches",
    filters: { interventionType: "DRUG", hasResults: true },
    ids: [],
  },
];

for (const { name, filters, ids } of cases) {
  test(name, () => {
    assert.deepEqual(
      filterStudies(studies, filters).map(
        (s) => s.protocolSection.identificationModule.nctId,
      ),
      ids,
    );
  });
}
