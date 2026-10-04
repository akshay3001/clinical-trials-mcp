import assert from "node:assert/strict";
import test from "node:test";

import type { FilterParams, Study } from "../src/models/types.js";
import { filterStudies } from "../src/utils/helpers.js";

test("matches upstream allocation values, including NA", () => {
  const studyWith = (nctId: string, allocation?: string) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        designModule: { designInfo: { allocation } },
      },
    }) as Study;
  const studies = [
    studyWith("NCT00000001", "RANDOMIZED"),
    studyWith("NCT00000002", "NON_RANDOMIZED"),
    studyWith("NCT00000003", "NA"),
    studyWith("NCT00000004"),
  ];
  const matchingIds = (allocation: FilterParams["allocation"]) =>
    filterStudies(studies, { allocation }).map(
      (study) => study.protocolSection.identificationModule.nctId,
    );

  assert.deepEqual(matchingIds("NA"), ["NCT00000003"]);
  assert.deepEqual(matchingIds("NON_RANDOMIZED"), ["NCT00000002"]);
});
