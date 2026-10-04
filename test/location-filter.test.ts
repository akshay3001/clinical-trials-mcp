import assert from "node:assert/strict";
import test from "node:test";

import type { FilterParams, Study } from "../src/models/types.js";
import { filterStudies } from "../src/utils/helpers.js";

type Site = { city?: string; state?: string; country?: string };

const studyWithSites = (nctId: string, locations: Site[]) =>
  ({
    protocolSection: {
      identificationModule: { nctId, briefTitle: nctId },
      contactsLocationsModule: { locations },
    },
  }) as Study;

const studies = [
  studyWithSites("NCT00000001", [{ city: "Lagos", country: "Nigeria" }]),
  studyWithSites("NCT00000002", [{ city: "Niamey", country: "Niger" }]),
  studyWithSites("NCT00000003", [
    { city: "Morgantown", state: "West Virginia", country: "United States" },
  ]),
  studyWithSites("NCT00000004", [
    { city: "Richmond", state: "Virginia", country: "United States" },
  ]),
  studyWithSites("NCT00000005", [
    { city: "Boston", state: "Massachusetts", country: "United States" },
    { city: "Paris", country: "France" },
  ]),
  studyWithSites("NCT00000006", [
    { city: "Paris", state: "Texas", country: "United States" },
  ]),
  studyWithSites("NCT00000007", [
    { city: "New York", state: "New York", country: "United States" },
  ]),
];

const matchingIds = (filters: FilterParams) =>
  filterStudies(studies, filters).map(
    (study) => study.protocolSection.identificationModule.nctId,
  );

test("matches location fields exactly and ignores case", () => {
  assert.deepEqual(matchingIds({ locationCountry: "niger" }), ["NCT00000002"]);
  assert.deepEqual(matchingIds({ locationState: "VIRGINIA" }), ["NCT00000004"]);
  assert.deepEqual(matchingIds({ locationCity: "york" }), []);
});

test("requires one site to match all location fields", () => {
  assert.deepEqual(
    matchingIds({ locationCountry: "United States", locationCity: "Paris" }),
    ["NCT00000006"],
  );
  assert.deepEqual(
    matchingIds({ locationCountry: "France", locationCity: "Paris" }),
    ["NCT00000005"],
  );
});
