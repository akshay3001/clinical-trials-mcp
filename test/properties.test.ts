import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";
import Papa from "papaparse";
import {
  StudySchema,
  type AdditionalExportColumn,
  type FilterParams,
  type Study,
} from "../src/models/types.js";
import { filterStudies } from "../src/utils/helpers.js";
import { exportToCSV, getExportPath } from "../src/utils/export.js";

const checks = {
  seed: Number(process.env.FC_SEED ?? 20261005),
  numRuns: 200,
  path: process.env.FC_PATH,
};
const optional = { requiredKeys: [] };
// Short text keeps failures readable. These choices reach CSV and Unicode edges.
const text = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 12 }),
  fc.constantFrom(
    "",
    "é試🧪",
    "a,b",
    'a"b',
    "a\nb",
    "a\rb",
    "=1+1",
    "+1",
    "-1",
    "@SUM(1)",
    " \t=1",
    "\ntext",
    "\uFEFF=1",
  ),
);
const count = fc.oneof(fc.constant(0), fc.nat({ max: 1000 }));
const age = fc
  .tuple(
    count,
    fc.constantFrom("Years", "Months", "Weeks", "Days", "Hours", "Minutes"),
  )
  .map(([n, unit]) => `${n} ${unit}`);
const date = fc
  .tuple(
    fc.integer({ min: 2000, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([y, m, d]) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );
const studyType = fc.constantFrom(
  "INTERVENTIONAL",
  "OBSERVATIONAL",
  "EXPANDED_ACCESS",
  "PATIENT_REGISTRY",
);
const sex = fc.constantFrom("ALL", "MALE", "FEMALE");
const sponsorClass = fc.constantFrom(
  "INDUSTRY",
  "NIH",
  "FED",
  "OTHER",
  "INDIV",
  "NETWORK",
  "OTHER_GOV",
  "UNKNOWN",
);
const allocation = fc.constantFrom("RANDOMIZED", "NON_RANDOMIZED", "NA");
const model = fc.constantFrom(
  "SINGLE_GROUP",
  "PARALLEL",
  "CROSSOVER",
  "FACTORIAL",
  "SEQUENTIAL",
);
const purpose = fc.constantFrom(
  "TREATMENT",
  "PREVENTION",
  "DIAGNOSTIC",
  "SUPPORTIVE_CARE",
  "SCREENING",
  "HEALTH_SERVICES_RESEARCH",
  "BASIC_SCIENCE",
  "DEVICE_FEASIBILITY",
  "OTHER",
);
const masking = fc.constantFrom(
  "NONE",
  "SINGLE",
  "DOUBLE",
  "TRIPLE",
  "QUADRUPLE",
);
const ageGroup = fc.constantFrom("CHILD", "ADULT", "OLDER_ADULT");
const outcome = fc.record({ measure: text }, optional);

// Omit optional keys instead of filling absent modules with defaults.
const study = fc.record(
  {
    protocolSection: fc.record(
      {
        identificationModule: fc.record({
          nctId: fc
            .nat({ max: 99999999 })
            .map((n) => `NCT${String(n).padStart(8, "0")}`),
          briefTitle: text,
        }),
        statusModule: fc.record(
          {
            overallStatus: fc.constantFrom(
              "RECRUITING",
              "COMPLETED",
              "UNKNOWN",
            ),
            startDateStruct: fc.record(
              {
                date: fc.oneof(
                  date,
                  fc.constantFrom("2020", "2020-02", "N/A", ""),
                ),
              },
              optional,
            ),
            completionDateStruct: fc.record({ date: text }, optional),
          },
          { requiredKeys: ["overallStatus"] },
        ),
        descriptionModule: fc.record({ briefSummary: text }, optional),
        conditionsModule: fc.record(
          {
            conditions: fc.array(text, { maxLength: 3 }),
            keywords: fc.array(text, { maxLength: 3 }),
          },
          optional,
        ),
        designModule: fc.record(
          {
            studyType,
            patientRegistry: fc.boolean(),
            phases: fc.array(text, { maxLength: 3 }),
            enrollmentInfo: fc.record({ count }, optional),
            designInfo: fc.record(
              {
                allocation,
                interventionModel: model,
                primaryPurpose: purpose,
                maskingInfo: fc.record({ masking }, optional),
              },
              optional,
            ),
          },
          optional,
        ),
        armsInterventionsModule: fc.record(
          {
            interventions: fc.array(
              fc.record({ type: text, name: text }, optional),
              { maxLength: 3 },
            ),
          },
          optional,
        ),
        outcomesModule: fc.record(
          {
            primaryOutcomes: fc.array(outcome, { maxLength: 3 }),
            secondaryOutcomes: fc.array(outcome, { maxLength: 3 }),
          },
          optional,
        ),
        eligibilityModule: fc.record(
          {
            eligibilityCriteria: text,
            sex,
            healthyVolunteers: fc.boolean(),
            minimumAge: fc.oneof(age, fc.constant("N/A")),
            maximumAge: fc.oneof(age, fc.constant("N/A")),
            stdAges: fc.array(ageGroup, { maxLength: 3 }),
          },
          optional,
        ),
        contactsLocationsModule: fc.record(
          {
            locations: fc.array(
              fc.record(
                { facility: text, city: text, state: text, country: text },
                optional,
              ),
              { maxLength: 3 },
            ),
          },
          optional,
        ),
        sponsorCollaboratorsModule: fc.record(
          {
            leadSponsor: fc.record(
              { name: text, class: sponsorClass },
              optional,
            ),
          },
          optional,
        ),
        oversightModule: fc.record(
          {
            isFdaRegulatedDrug: fc.boolean(),
            isFdaRegulatedDevice: fc.boolean(),
          },
          optional,
        ),
      },
      { requiredKeys: ["identificationModule", "statusModule"] },
    ),
    hasResults: fc.boolean(),
  },
  { requiredKeys: ["protocolSection"] },
) satisfies fc.Arbitrary<Study>;

// Select at most two fields so active filters can keep part of a study list.
const filters = fc
  .uniqueArray(
    fc.oneof(
      fc.record({ locationCountry: text }),
      fc.record({ locationState: text }),
      fc.record({ locationCity: text }),
      fc.record({ enrollmentMin: count }),
      fc.record({ enrollmentMax: count }),
      fc.record({ startDateAfter: date }),
      fc.record({ startDateBefore: date }),
      fc.record({ interventionType: text }),
      fc.record({ hasResults: fc.boolean() }),
      fc.record({ studyType }),
      fc.record({ sex }),
      fc.record({ healthyVolunteers: fc.boolean() }),
      fc.record({ sponsorClass }),
      fc.record({ allocation }),
      fc.record({ interventionModel: model }),
      fc.record({ primaryPurpose: purpose }),
      fc.record({ minAge: age }),
      fc.record({ maxAge: age }),
      fc.record({ patientAge: age }),
      fc.record({ ageGroups: fc.array(ageGroup, { maxLength: 3 }) }),
      fc.record({ masking }),
      fc.record({ fdaRegulated: fc.boolean() }),
      fc.record({ keyword: text }),
    ),
    { maxLength: 2, selector: (part) => Object.keys(part)[0] },
  )
  .map((parts) =>
    parts.reduce<FilterParams>((filter, part) => ({ ...filter, ...part }), {}),
  );
const studies = fc.array(study, { maxLength: 8 });

test("property: refinement never adds a study", () => {
  let partialResults = 0;
  fc.assert(
    fc.property(studies, filters, (input, filter) => {
      const before = JSON.stringify(input);
      const members = new Set<Study>(input);
      const output = filterStudies(input, filter);
      assert.ok(output.every((item) => members.has(item)));
      assert.ok(output.length <= input.length);
      assert.equal(JSON.stringify(input), before);
      if (output.length > 0 && output.length < input.length) partialResults++;
    }),
    checks,
  );
  if (!checks.path) {
    assert.ok(
      partialResults > 0,
      "generator must reach partial refinement results",
    );
  }
});

test("property: refinement keeps order and cumulative results", () => {
  let partialResults = 0;
  fc.assert(
    fc.property(studies, filters, filters, (input: Study[], first, second) => {
      const output = filterStudies(input, first);
      let cursor = 0;
      for (const item of output) {
        const index = input.indexOf(item, cursor);
        assert.ok(index >= cursor, "output must be a subsequence of input");
        cursor = index + 1;
      }
      if (output.length > 0 && output.length < input.length) partialResults++;
      assert.deepEqual(
        filterStudies(output, second),
        filterStudies(filterStudies(input, second), first),
      );
    }),
    checks,
  );
  if (!checks.path) {
    assert.ok(
      partialResults > 0,
      "generator must reach partial refinement results",
    );
  }
});

// The CSV contract treats empty strings and empty collections as absent.
function cell(value: string | number | boolean | undefined): string {
  if (value === undefined || value === "") return "BLANK";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return protectedText(String(value));
}

function protectedText(raw: string): string {
  const trimmed = raw.trimStart();
  const whitespace = raw.slice(0, raw.length - trimmed.length);
  return "=+-@".includes(trimmed[0] ?? "\0") || /[\t\r\n]/.test(whitespace)
    ? `'${raw}`
    : raw;
}

function expectedCSV(s: Study) {
  const p = s.protocolSection;
  const d = p.designModule;
  const e = p.eligibilityModule;
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  const measures = (items: { measure?: string }[] | undefined) =>
    items
      ?.flatMap((item) => (item.measure === undefined ? [] : [item.measure]))
      .join("; ");
  return {
    NCT_ID: protectedText(p.identificationModule.nctId),
    Title: protectedText(p.identificationModule.briefTitle),
    Status: protectedText(p.statusModule.overallStatus),
    Phase: cell(d?.phases?.join(", ")),
    Enrollment: cell(d?.enrollmentInfo?.count),
    StartDate: cell(p.statusModule.startDateStruct?.date),
    CompletionDate: cell(p.statusModule.completionDateStruct?.date),
    Conditions: cell(p.conditionsModule?.conditions?.join("; ")),
    Interventions: cell(
      interventions
        .flatMap((i) => {
          if (i.type && i.name) return [`${i.type}: ${i.name}`];
          return i.type ? [i.type] : i.name ? [i.name] : [];
        })
        .join("; "),
    ),
    PrimaryOutcomes: cell(measures(p.outcomesModule?.primaryOutcomes)),
    SecondaryOutcomes: cell(measures(p.outcomesModule?.secondaryOutcomes)),
    Locations: cell(
      p.contactsLocationsModule?.locations
        ?.map((l) =>
          [l.facility, l.city, l.state, l.country]
            .filter((part) => part !== undefined && part !== "")
            .join(", "),
        )
        .join("; "),
    ),
    Sponsor: cell(p.sponsorCollaboratorsModule?.leadSponsor?.name),
    Summary: cell(p.descriptionModule?.briefSummary),
    EligibilityCriteria: cell(e?.eligibilityCriteria),
    MinAge: cell(e?.minimumAge),
    MaxAge: cell(e?.maximumAge),
    Sex: cell(e?.sex),
    SponsorType: cell(p.sponsorCollaboratorsModule?.leadSponsor?.class),
    InterventionType: cell(
      interventions.flatMap((i) => (i.type ? [i.type] : [])).join("; "),
    ),
    IsFDARegulatedDrug: cell(p.oversightModule?.isFdaRegulatedDrug),
    IsFDARegulatedDevice: cell(p.oversightModule?.isFdaRegulatedDevice),
    HealthyVolunteers: cell(e?.healthyVolunteers),
    AgeGroups: cell(e?.stdAges?.join(", ")),
    PrimaryPurpose: cell(d?.designInfo?.primaryPurpose),
    AllocationMethod: cell(d?.designInfo?.allocation),
    InterventionModel: cell(d?.designInfo?.interventionModel),
    StudyType: cell(d?.studyType),
  };
}
const additionalColumns = [
  "MinAge",
  "MaxAge",
  "Sex",
  "SponsorType",
  "InterventionType",
  "IsFDARegulatedDrug",
  "IsFDARegulatedDevice",
  "HealthyVolunteers",
  "AgeGroups",
  "PrimaryPurpose",
  "AllocationMethod",
  "InterventionModel",
  "StudyType",
] satisfies AdditionalExportColumn[];

function exportRoot(t: test.TestContext) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinical-trials-properties-"),
  );
  const previous = process.env.CLINICAL_TRIALS_EXPORTS_DIR;
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = path.join(temp, "exports");
  t.after(() => {
    if (previous === undefined) delete process.env.CLINICAL_TRIALS_EXPORTS_DIR;
    else process.env.CLINICAL_TRIALS_EXPORTS_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return temp;
}

test("property: CSV round trip keeps values and protects cells", async (t) => {
  exportRoot(t);
  await fc.assert(
    fc.asyncProperty(
      fc.array(study, { minLength: 1, maxLength: 4 }),
      async (input) => {
        input.forEach((item) => StudySchema.parse(item));
        const destination = await exportToCSV(
          input,
          "round-trip.csv",
          additionalColumns,
        );
        try {
          const csv = fs.readFileSync(destination, "utf8");
          const parsed = Papa.parse<Record<string, string>>(csv, {
            header: true,
          });
          assert.deepEqual(parsed.errors, []);
          assert.deepEqual(parsed.data, input.map(expectedCSV));
          for (const row of parsed.data) {
            for (const value of Object.values(row)) {
              assert.ok(!value.includes("undefined"));
              assert.ok(
                !/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(value),
                "formula cell must have an apostrophe",
              );
            }
          }
        } finally {
          fs.unlinkSync(destination);
        }
      },
    ),
    checks,
  );
});

test("property: export paths stay inside the root or reject", (t) => {
  const temp = fs.realpathSync(exportRoot(t));
  fs.mkdirSync(path.join(temp, "exports"));
  const root = fs.realpathSync(path.join(temp, "exports"));
  const outside = path.join(temp, "outside");
  fs.mkdirSync(outside);
  assert.equal(
    getExportPath("safe.csv", "csv"),
    path.join(root, "csv", "safe.csv"),
  );
  const absolute = path.join(root, "nested", "safe.json");
  assert.equal(getExportPath(absolute, "json"), absolute);
  const segment = fc.oneof(
    fc.constantFrom(
      "..",
      ".",
      "linked",
      "csv",
      "a b",
      "é試",
      "a\\b",
      "a:b",
      "",
      "\0",
    ),
    fc.string({ maxLength: 8 }),
  );
  const relative = fc
    .array(segment, { minLength: 1, maxLength: 4 })
    .map((parts) => parts.join(path.sep));
  const outputPath = fc.oneof(
    fc.constant(path.join(root, "linked")),
    relative,
    relative.map((p) => `${root}/${p}`),
    relative.map((p) => `${outside}/${p}`),
    relative.map((p) => `${root}-sibling/${p}`),
  );
  fc.assert(
    fc.property(
      outputPath,
      fc.constantFrom("csv", "json", "jsonl"),
      (output, format) => {
        // Each run starts with the same state, including when replaying a path.
        fs.rmSync(temp, { recursive: true, force: true });
        fs.mkdirSync(temp);
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, "linked"));
        let destination: string;
        try {
          destination = getExportPath(output, format);
        } catch (error) {
          assert.ok(error instanceof Error);
          return;
        } finally {
          assert.deepEqual(fs.readdirSync(outside), []);
          assert.deepEqual(fs.readdirSync(temp).sort(), ["exports", "outside"]);
        }
        // Check outside the catch so a failed assertion cannot count as rejection.
        assert.ok(path.isAbsolute(destination));
        const relative = path.relative(root, destination);
        assert.ok(
          relative !== "" &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative),
        );
        const parent = fs.realpathSync(path.dirname(destination));
        assert.ok(
          parent === root || parent.startsWith(`${root}${path.sep}`),
          "parent must also be inside after symlink resolution",
        );
        assert.equal(
          fs.lstatSync(destination, { throwIfNoEntry: false }),
          undefined,
          "destination must not already exist",
        );
      },
    ),
    checks,
  );
});
