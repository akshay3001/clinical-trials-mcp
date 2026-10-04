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

    if (url.searchParams.get("query.term") === "(fail)") {
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

test("fetchAll drops a study that repeats on a later page", async () => {
  const withId = (nctId: string) => ({
    protocolSection: {
      ...study.protocolSection,
      identificationModule: { nctId, briefTitle: nctId },
    },
  });
  const pages: Record<string, { studies: unknown[]; nextPageToken?: string }> =
    {
      first: {
        studies: [withId("NCT00000001"), withId("NCT00000002")],
        nextPageToken: "second",
      },
      second: { studies: [withId("NCT00000002"), withId("NCT00000003")] },
    };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page = pages[url.searchParams.get("pageToken") ?? "first"];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ...page, totalCount: 3 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    const nctIds: string[] = [];
    for await (const batch of client.searchAll({ pageSize: 2 })) {
      nctIds.push(
        ...batch.map((s) => s.protocolSection.identificationModule.nctId),
      );
    }
    assert.deepEqual(nctIds, ["NCT00000001", "NCT00000002", "NCT00000003"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("groups each query part so OR stays inside its own part", async () => {
  let queryTerm: string | null = null;
  const server = createServer((request, response) => {
    queryTerm = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).searchParams.get("query.term");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ studies: [], totalCount: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    await client.search({
      query: "heart OR lung",
      condition: "diabetes OR obesity",
      location: "Boston",
      phase: ["PHASE2", "PHASE3"],
      pageSize: 10,
    });
    assert.equal(
      queryTerm,
      "(heart OR lung) AND AREA[ConditionSearch](diabetes OR obesity) AND AREA[LocationSearch](Boston) AND AREA[Phase](PHASE2 OR PHASE3)",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("sends status as a comma-separated list of enum values", async () => {
  let overallStatus: string | null = null;
  const server = createServer((request, response) => {
    overallStatus = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).searchParams.get("filter.overallStatus");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ studies: [], totalCount: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    await client.search({
      status: ["ACTIVE_NOT_RECRUITING", "NOT_YET_RECRUITING"],
      pageSize: 10,
    });
    assert.equal(overallStatus, "ACTIVE_NOT_RECRUITING,NOT_YET_RECRUITING");
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

test("rejects invalid studies instead of returning unvalidated data", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.startsWith("/studies?")
          ? { studies: [study, {}], totalCount: 2 }
          : { protocolSection: {} },
      ),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    const result = await client.search({ condition: "diabetes", pageSize: 10 });
    assert.deepEqual(
      result.studies.map(
        (parsed) => parsed.protocolSection.identificationModule.nctId,
      ),
      ["NCT00000001"],
    );
    await assert.rejects(client.getStudy("NCT00000002"), /invalid study/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects a search body without studies instead of returning zero results", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: "temporarily unavailable" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    await assert.rejects(
      client.search({ condition: "diabetes", pageSize: 10 }),
      /invalid search response/,
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

test("gives each attempt its own timeout", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503).end("unavailable");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    // Backoff waits are 1s and 2s, so the full run is longer than timeoutMs.
    await assert.rejects(
      client.search({ pageSize: 10 }, { timeoutMs: 2_500 }),
      /after 3 attempts: HTTP 503/,
    );
    assert.equal(requestCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("waits for Retry-After on a 429 instead of the exponential backoff", async () => {
  const retryAfter = ["0", new Date().toUTCString()];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    const header = retryAfter[requestCount++];
    if (header !== undefined) {
      response.writeHead(429, { "retry-after": header }).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ studies: [], totalCount: 0 }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ClinicalTrialsAPIClient(
    `http://127.0.0.1:${address.port}`,
  );

  try {
    // Exponential backoff would wait 1s + 2s. Both headers mean "now".
    const start = Date.now();
    await client.search({ pageSize: 10 });
    assert.equal(requestCount, 3);
    assert.ok(Date.now() - start < 900, `took ${Date.now() - start}ms`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
