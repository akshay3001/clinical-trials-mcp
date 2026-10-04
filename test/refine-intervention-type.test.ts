import assert from "node:assert/strict";
import test from "node:test";

import type { Study } from "../src/models/types.js";
import { filterStudies } from "../src/utils/helpers.js";

test("matches intervention type labels to upstream enum values", () => {
  const studyWith = (nctId: string, type?: string) =>
    ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: nctId },
        armsInterventionsModule: { interventions: [{ type, name: nctId }] },
      },
    }) as Study;
  const studies = [
    studyWith("NCT00000001", "DIETARY_SUPPLEMENT"),
    studyWith("NCT00000002", "DRUG"),
    studyWith("NCT00000003"),
  ];
  const matchingIds = (interventionType: string) =>
    filterStudies(studies, { interventionType }).map(
      (study) => study.protocolSection.identificationModule.nctId,
    );

  assert.deepEqual(matchingIds("Dietary Supplement"), ["NCT00000001"]);
  assert.deepEqual(matchingIds("DIETARY_SUPPLEMENT"), ["NCT00000001"]);
  assert.deepEqual(matchingIds("drug"), ["NCT00000002"]);
});
