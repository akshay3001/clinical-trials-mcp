import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { ClinicalTrialsAPIClient } from "../src/api/client.js";
import {
  SearchParamsSchema,
  SearchResponseSchema,
  StudySchema,
} from "../src/models/types.js";

const study = {
  protocolSection: {
    identificationModule: {
      nctId: "NCT00000001",
      briefTitle: "Test study",
    },
    statusModule: { overallStatus: "RECRUITING" },
  },
};

test("keeps ClinicalTrials.gov response compatibility under Zod 4", () => {
  const representativeStudy = {
    ...study,
    protocolSection: {
      ...study.protocolSection,
      identificationModule: {
        ...study.protocolSection.identificationModule,
        officialTitle: "A representative trial",
        upstreamIdentificationField: "preserved",
      },
      conditionsModule: {
        conditions: ["Diabetes"],
        upstreamConditionsField: true,
      },
    },
    upstreamStudyField: { preserved: true },
  };

  const parsedStudy = StudySchema.parse(representativeStudy);
  assert.equal(
    parsedStudy.protocolSection.identificationModule
      .upstreamIdentificationField,
    "preserved",
  );
  assert.deepEqual(parsedStudy.upstreamStudyField, { preserved: true });

  const parsedResponse = SearchResponseSchema.parse({
    studies: [representativeStudy],
    totalCount: 1,
    upstreamResponseField: "preserved",
  });
  assert.equal(parsedResponse.studies.length, 1);
  assert.equal(parsedResponse.upstreamResponseField, "preserved");
  assert.equal(SearchParamsSchema.parse({}).pageSize, 1000);
  assert.throws(
    () => StudySchema.parse({ protocolSection: {} }),
    /identificationModule/,
  );
});

test("bounds pagination and does not retry non-retryable HTTP failures", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.searchParams.get("query.term") === "fail") {
      response.writeHead(400).end("bad request");
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        studies: [study, { ...study, extra: true }],
        nextPageToken: "another-page",
        totalCount: 20,
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    const batches = [];
    for await (const batch of client.searchAll(
      { pageSize: 1000 },
      { maxResults: 1 },
    )) {
      batches.push(batch);
    }
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.length, 1);
    assert.equal(requestCount, 1);

    await assert.rejects(
      client.search({ query: "fail", pageSize: 1000 }),
      /after 1 attempt: HTTP 400/,
    );
    assert.equal(requestCount, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("parses the direct Study returned by the single-study endpoint", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(study));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    const result = await client.getStudy("NCT00000001");
    assert.equal(
      result.protocolSection.identificationModule.nctId,
      "NCT00000001",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("propagates caller cancellation to upstream fetch", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ studies: [] }));
    }, 1_000);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );
  const controller = new AbortController();

  try {
    const pending = client.search(
      { pageSize: 1000 },
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    controller.abort(new Error("test cancellation"));
    await assert.rejects(pending, /test cancellation/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
