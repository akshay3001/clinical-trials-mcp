import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";
import { StudySchema } from "../../src/models/types.js";
import { withHttpStub } from "../helpers/http-stub.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverEntry = path.join(projectRoot, "dist", "mcp", "server.js");
const expectedTools = [
  "search_trials",
  "refine_results",
  "get_trial_details",
  "summarize_session",
  "export_results",
];

async function withStdioClient(
  mode: "modern" | "legacy",
  run: (
    client: Client,
    runtimeDirectory: string,
    transport: StdioClientTransport,
  ) => Promise<void>,
  configuration: Record<string, string> | boolean = {},
): Promise<void> {
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `clinical-trials-mcp-${mode}-`),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args:
      configuration === true
        ? [
            "--import",
            import.meta.resolve("tsx"),
            "--import",
            path.join(projectRoot, "test/fixtures/upstream.ts"),
            serverEntry,
          ]
        : [serverEntry],
    cwd: runtimeDirectory,
    stderr: "pipe",
    env: {
      CLINICAL_TRIALS_MCP_DATA_DIR: runtimeDirectory,
      CLINICAL_TRIALS_EXPORTS_DIR: path.join(runtimeDirectory, "exports"),
      ...(typeof configuration === "object" ? configuration : {}),
    },
  });
  const client = new Client(
    { name: "clinical-trials-mcp-test", version: "1.0.0" },
    mode === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : undefined,
  );

  try {
    await client.connect(transport);
    await run(client, runtimeDirectory, transport);
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await transport.close();
      } finally {
        fs.rmSync(runtimeDirectory, { recursive: true, force: true });
      }
    }
  }
}

test("searches, refines cumulatively, and exports through stdio", async () => {
  const study = (
    nctId: string,
    label: string,
    country: string,
    enrollment: number,
  ) => ({
    protocolSection: {
      identificationModule: { nctId, briefTitle: `Diabetes study ${label}` },
      statusModule: { overallStatus: "RECRUITING" },
      conditionsModule: { conditions: ["Diabetes"] },
      designModule: {
        enrollmentInfo: { count: enrollment, type: "ESTIMATED" },
      },
      contactsLocationsModule: { locations: [{ country }] },
    },
  });
  // API order differs from NCT ID order so sorting cannot pass unnoticed.
  const studies = [
    study("NCT00000009", "A", "United States", 200),
    study("NCT00000002", "B", "United States", 50),
    study("NCT00000007", "C", "Canada", 300),
    study("NCT00000001", "D", "Canada", 25),
  ];
  studies.forEach((fixture) => StudySchema.parse(fixture));
  const requests: { method: string | undefined; url: string | undefined }[] =
    [];
  const upstream = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ studies, totalCount: studies.length }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");

    await withStdioClient(
      "modern",
      async (client, runtimeDirectory) => {
        const database = new Database(
          path.join(runtimeDirectory, "data", "clinical-trials.db"),
          { readonly: true },
        );
        try {
          const storedStudies = database.prepare<
            [],
            { nct_id: string; brief_title: string; enrollment_count: number }
          >(
            "SELECT nct_id, brief_title, enrollment_count FROM studies ORDER BY nct_id",
          );
          const sessionResults = database.prepare<[string], { nct_id: string }>(
            "SELECT nct_id FROM session_results WHERE session_id = ? ORDER BY position",
          );
          assert.deepEqual(storedStudies.all(), []);
          assert.deepEqual(
            fs.readdirSync(path.join(runtimeDirectory, "cache")),
            [],
          );

          const search = await client.callTool({
            name: "search_trials",
            arguments: { condition: "diabetes" },
          });
          assert.notEqual(search.isError, true);
          const searchText = JSON.stringify(search.content);
          assert.match(searchText, /Search found 4 studies/);
          const sessionId = searchText.match(
            /\*\*Session ID:\*\* ([0-9a-f-]{36})/,
          )?.[1];
          assert.ok(sessionId);
          const ids = studies.map(
            (s) => s.protocolSection.identificationModule.nctId,
          );
          assert.deepEqual(
            sessionResults.all(sessionId),
            ids.map((nct_id) => ({ nct_id })),
          );
          const expectedStored = studies
            .map(({ protocolSection: s }) => ({
              nct_id: s.identificationModule.nctId,
              brief_title: s.identificationModule.briefTitle,
              enrollment_count: s.designModule.enrollmentInfo.count,
            }))
            .sort((a, b) => a.nct_id.localeCompare(b.nct_id));
          assert.deepEqual(storedStudies.all(), expectedStored);
          assert.equal(requests.length, 1);
          assert.equal(requests[0]?.method, "GET");
          const requestedUrl = new URL(
            requests[0]?.url ?? "",
            "http://127.0.0.1",
          );
          assert.equal(requestedUrl.pathname, "/api/v2/studies");
          assert.deepEqual(
            [...requestedUrl.searchParams],
            [
              ["query.term", "AREA[ConditionSearch](diabetes)"],
              ["pageSize", "1000"],
              ["countTotal", "true"],
            ],
          );

          const countryRefinement = await client.callTool({
            name: "refine_results",
            arguments: { sessionId, locationCountry: "United States" },
          });
          assert.notEqual(countryRefinement.isError, true);
          assert.match(
            JSON.stringify(countryRefinement.content),
            /Filtered from 4 to 2 studies/,
          );
          assert.match(
            JSON.stringify(countryRefinement.content),
            new RegExp(`\\*\\*Session ID:\\*\\* ${sessionId}`),
          );
          assert.deepEqual(
            sessionResults.all(sessionId),
            ids.slice(0, 2).map((nct_id) => ({ nct_id })),
          );
          assert.equal(requests.length, 1);

          const enrollmentRefinement = await client.callTool({
            name: "refine_results",
            arguments: { sessionId, enrollmentMin: 100 },
          });
          assert.notEqual(enrollmentRefinement.isError, true);
          assert.match(
            JSON.stringify(enrollmentRefinement.content),
            /Filtered from 2 to 1 study/,
          );
          assert.match(
            JSON.stringify(enrollmentRefinement.content),
            new RegExp(`\\*\\*Session ID:\\*\\* ${sessionId}`),
          );
          assert.deepEqual(sessionResults.all(sessionId), [{ nct_id: ids[0] }]);
          assert.equal(requests.length, 1);

          const exported = await client.callTool({
            name: "export_results",
            arguments: {
              sessionId,
              format: "json",
              outputPath: "workflow.json",
            },
          });
          assert.notEqual(exported.isError, true);
          const exportedStudies: unknown = JSON.parse(
            fs.readFileSync(
              path.join(runtimeDirectory, "exports", "json", "workflow.json"),
              "utf8",
            ),
          );
          assert.ok(Array.isArray(exportedStudies));
          assert.equal(exportedStudies.length, 1);
          assert.deepEqual(exportedStudies, [studies[0]]);
          assert.deepEqual(sessionResults.all(sessionId), [{ nct_id: ids[0] }]);
          assert.deepEqual(storedStudies.all(), expectedStored);
          assert.equal(requests.length, 1);
        } finally {
          database.close();
        }
      },
      {
        CLINICAL_TRIALS_API_BASE_URL: `http://127.0.0.1:${address.port}/api/v2`,
      },
    );
  } finally {
    upstream.closeAllConnections();
    if (upstream.listening) {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("serves MCP 2026-07-28 over stdio with deterministic tools", async () => {
  await withStdioClient("modern", async (client, runtimeDirectory) => {
    assert.equal(client.getProtocolEra(), "modern");
    assert.ok(client.getDiscoverResult());

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      expectedTools,
    );

    const searchTool = tools.find((tool) => tool.name === "search_trials");
    const pageSizeSchema = searchTool?.inputSchema.properties?.pageSize;
    const fetchLimitSchema = searchTool?.inputSchema.properties?.fetchLimit;
    assert.ok(
      pageSizeSchema &&
        typeof pageSizeSchema === "object" &&
        !Array.isArray(pageSizeSchema),
    );
    assert.ok(
      fetchLimitSchema &&
        typeof fetchLimitSchema === "object" &&
        !Array.isArray(fetchLimitSchema),
    );
    assert.equal(pageSizeSchema.maximum, 1000);
    assert.equal(fetchLimitSchema.maximum, 10_000);

    const invalidInput = await client.callTool({
      name: "get_trial_details",
      arguments: { nctId: "not-an-nct-id" },
    });
    assert.equal(invalidInput.isError, true);

    const impossiblePagination = await client.callTool({
      name: "search_trials",
      arguments: { fetchAll: true, pageSize: 1, fetchLimit: 101 },
    });
    assert.equal(impossiblePagination.isError, true);

    const missingSession = await client.callTool({
      name: "summarize_session",
      arguments: { sessionId: "missing-session" },
    });
    assert.equal(missingSession.isError, true);
    assert.match(JSON.stringify(missingSession.content), /not found/i);

    const runtimeDatabase = new Database(
      path.join(runtimeDirectory, "data", "clinical-trials.db"),
    );
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const seededStudy = {
      protocolSection: {
        identificationModule: {
          nctId: "NCT00000001",
          briefTitle: "Seeded protocol test study",
        },
        statusModule: { overallStatus: "RECRUITING" },
      },
    };
    try {
      runtimeDatabase.pragma("foreign_keys = ON");
      runtimeDatabase
        .prepare(
          "INSERT INTO studies (nct_id, brief_title, raw_json, raw_json_upstream_hash) VALUES (?, ?, ?, ?)",
        )
        .run(
          "NCT00000001",
          "Seeded protocol test study",
          JSON.stringify(seededStudy),
          createHash("sha256")
            .update(JSON.stringify(seededStudy))
            .digest("hex"),
        );
      runtimeDatabase
        .prepare(
          "INSERT INTO search_sessions (session_id, search_params, expires_at) VALUES (?, ?, ?)",
        )
        .run(sessionId, "{}", Math.ceil(Date.now() / 1000) + 3_600);
      runtimeDatabase
        .prepare(
          "INSERT INTO session_results (session_id, nct_id) VALUES (?, ?)",
        )
        .run(sessionId, "NCT00000001");
    } finally {
      runtimeDatabase.close();
    }

    const summary = await client.callTool({
      name: "summarize_session",
      arguments: { sessionId, maxResults: 1 },
    });
    assert.notEqual(summary.isError, true);
    assert.match(JSON.stringify(summary.content), /Seeded protocol test study/);

    const details = await client.callTool({
      name: "get_trial_details",
      arguments: { nctId: "NCT00000001", includeEligibility: false },
    });
    assert.notEqual(details.isError, true);
    assert.match(JSON.stringify(details.content), /Seeded protocol test study/);

    const refined = await client.callTool({
      name: "refine_results",
      arguments: { sessionId },
    });
    assert.notEqual(refined.isError, true);
    assert.match(JSON.stringify(refined.content), /Filtered from 1 to 1 study/);
    assert.match(JSON.stringify(refined.content), new RegExp(sessionId));
    assert.doesNotMatch(
      JSON.stringify(refined.content),
      /Seeded protocol test study/,
    );

    const exported = await client.callTool({
      name: "export_results",
      arguments: { sessionId, format: "json", outputPath: "protocol.json" },
    });
    assert.notEqual(exported.isError, true);
    assert.equal(
      fs.existsSync(
        path.join(runtimeDirectory, "exports", "json", "protocol.json"),
      ),
      true,
    );
  });
});

test("a cache hit keeps newer stored studies and adds missing ones", async () => {
  await withStdioClient("modern", async (client, runtimeDirectory) => {
    const studyFixture = (
      nctId: string,
      title: string,
      lastUpdate: string,
    ) => ({
      protocolSection: {
        identificationModule: { nctId, briefTitle: title },
        statusModule: {
          overallStatus: "RECRUITING",
          lastUpdatePostDateStruct: { date: lastUpdate },
        },
      },
    });
    const newer = studyFixture(
      "NCT00000002",
      "Newer stored title",
      "2026-10-04",
    );

    const runtimeDatabase = new Database(
      path.join(runtimeDirectory, "data", "clinical-trials.db"),
    );
    try {
      runtimeDatabase
        .prepare(
          "INSERT INTO studies (nct_id, brief_title, raw_json) VALUES (?, ?, ?)",
        )
        .run("NCT00000002", "Newer stored title", JSON.stringify(newer));
    } finally {
      runtimeDatabase.close();
    }

    // Write the disk entry that search_trials reads for { query: "rollback" }.
    // The schema adds the default pageSize, and keys are sorted.
    const params = { pageSize: 1000, query: "rollback" };
    const hash = createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex");
    fs.writeFileSync(
      path.join(runtimeDirectory, "cache", `searchUpstream:${hash}.json`),
      JSON.stringify({
        params,
        timestamp: Date.now(),
        data: {
          studies: [
            studyFixture("NCT00000002", "Old cached title", "2020-01-01"),
            studyFixture("NCT00000003", "Cached only title", "2020-01-01"),
          ],
          totalCount: 2,
        },
      }),
    );

    const search = await client.callTool({
      name: "search_trials",
      arguments: { query: "rollback" },
    });
    assert.notEqual(search.isError, true);
    const sessionId = JSON.stringify(search.content).match(
      /\*\*Session ID:\*\* ([0-9a-f-]{36})/,
    )?.[1];
    assert.ok(sessionId);

    const summary = JSON.stringify(
      (
        await client.callTool({
          name: "summarize_session",
          arguments: { sessionId, maxResults: 2 },
        })
      ).content,
    );
    assert.match(summary, /Newer stored title/);
    assert.match(summary, /Cached only title/);
    assert.doesNotMatch(summary, /Old cached title/);
  });
});

test("reports a cut-off single-page search", async () => {
  await withStdioClient("modern", async (client, runtimeDirectory) => {
    // Seed the disk cache so the search uses a first page with more pages
    // left, without a network call. The params are the parsed tool input.
    const params = { condition: "truncation-test", pageSize: 1000 };
    const key = createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex");
    const study = {
      protocolSection: {
        identificationModule: { nctId: "NCT00000002", briefTitle: "Page" },
        statusModule: { overallStatus: "RECRUITING" },
      },
    };
    fs.writeFileSync(
      path.join(runtimeDirectory, "cache", `searchUpstream:${key}.json`),
      JSON.stringify({
        data: { studies: [study], nextPageToken: "next", totalCount: 50_000 },
        params,
        timestamp: Date.now(),
      }),
    );

    const result = await client.callTool({
      name: "search_trials",
      arguments: { condition: "truncation-test" },
    });
    assert.notEqual(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /Search found 1 of 50,000 studies \(first page only\)\. Set fetchAll to true/,
    );
  });
});

test("continues to serve legacy MCP clients", async () => {
  await withStdioClient("legacy", async (client) => {
    assert.equal(client.getProtocolEra(), "legacy");
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      expectedTools,
    );
  });
});

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test barrier timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "a later page failure creates no successful session or reusable partial cache",
  { timeout: 15_000 },
  async () => {
    const tokens: (string | null)[] = [];
    let fail = true;
    const fixture = StudySchema.parse({
      protocolSection: {
        identificationModule: {
          nctId: "NCT00000001",
          briefTitle: "First page",
        },
        statusModule: { overallStatus: "RECRUITING" },
      },
    });
    await withHttpStub(
      (request, response) => {
        const token = new URL(
          request.url ?? "/",
          "http://localhost",
        ).searchParams.get("pageToken");
        tokens.push(token);
        if (token && fail) response.writeHead(500).end();
        else
          response.end(
            JSON.stringify({
              studies: token ? [] : [fixture],
              ...(token ? {} : { nextPageToken: "second" }),
            }),
          );
      },
      async (baseUrl) => {
        await withStdioClient(
          "modern",
          async (client, runtimeDirectory) => {
            const database = new Database(
              path.join(runtimeDirectory, "data", "clinical-trials.db"),
              { readonly: true },
            );
            try {
              const args = {
                query: "later-page",
                fetchAll: true,
                pageSize: 1,
                fetchLimit: 2,
              };
              const failed = await client.callTool({
                name: "search_trials",
                arguments: args,
              });
              assert.equal(failed.isError, true);
              assert.match(
                JSON.stringify(failed.content),
                /after 3 attempts: HTTP 500/,
              );
              assert.doesNotMatch(JSON.stringify(failed.content), /Session ID/);
              assert.deepEqual(tokens, [null, "second", "second", "second"]);
              assert.deepEqual(
                database
                  .prepare("SELECT COUNT(*) AS count FROM search_sessions")
                  .get(),
                { count: 0 },
              );
              assert.deepEqual(
                fs
                  .readdirSync(path.join(runtimeDirectory, "cache"))
                  .filter((name) => /^search(?:Upstream|AllV2):/.test(name)),
                [],
              );
              fail = false;
              const recovered = await client.callTool({
                name: "search_trials",
                arguments: args,
              });
              assert.notEqual(recovered.isError, true);
              assert.match(
                JSON.stringify(recovered.content),
                /Search found 1 study/,
              );
              assert.deepEqual(tokens, [
                null,
                "second",
                "second",
                "second",
                null,
                "second",
              ]);
              assert.deepEqual(
                database
                  .prepare("SELECT COUNT(*) AS count FROM search_sessions")
                  .get(),
                { count: 1 },
              );
              assert.equal(
                fs
                  .readdirSync(path.join(runtimeDirectory, "cache"))
                  .filter((name) => /^search(?:Upstream|AllV2):/.test(name))
                  .length,
                1,
              );
              const cached = await client.callTool({
                name: "search_trials",
                arguments: args,
              });
              assert.notEqual(cached.isError, true);
              assert.equal(tokens.length, 6);
            } finally {
              database.close();
            }
          },
          { CLINICAL_TRIALS_API_BASE_URL: baseUrl },
        );
      },
    );
  },
);

test(
  "MCP normalizes status order but separates pagination and fetch cache identities",
  { timeout: 10_000 },
  async () => {
    const requests: URL[] = [];
    await withHttpStub(
      (request, response) => {
        requests.push(new URL(request.url ?? "/", "http://localhost"));
        response.end(JSON.stringify({ studies: [], totalCount: 0 }));
      },
      async (baseUrl) => {
        await withStdioClient(
          "modern",
          async (client, runtimeDirectory) => {
            const search = async (args: Record<string, unknown>) => {
              const result = await client.callTool({
                name: "search_trials",
                arguments: args,
              });
              assert.notEqual(result.isError, true);
            };
            await search({
              query: "identity",
              status: ["RECRUITING", "COMPLETED"],
            });
            await search({
              status: ["COMPLETED", "RECRUITING"],
              query: "identity",
              pageSize: 1000,
              fetchAll: false,
            });
            assert.equal(requests.length, 1);
            assert.equal(
              requests[0]?.searchParams.get("filter.overallStatus"),
              "COMPLETED,RECRUITING",
            );
            await search({
              query: "identity",
              status: ["COMPLETED", "RECRUITING"],
              pageSize: 2,
            });
            await search({
              query: "identity",
              status: ["COMPLETED", "RECRUITING"],
              fetchAll: true,
              fetchLimit: 2,
            });
            await search({
              query: "identity",
              status: ["COMPLETED", "RECRUITING"],
              fetchAll: true,
              fetchLimit: 3,
            });
            assert.equal(requests.length, 4);
            assert.equal(requests[1]?.searchParams.get("pageSize"), "2");
            await search({
              query: "identity",
              status: ["RECRUITING", "COMPLETED"],
              fetchAll: true,
              fetchLimit: 2,
            });
            assert.equal(requests.length, 4);
            const database = new Database(
              path.join(runtimeDirectory, "data", "clinical-trials.db"),
              { readonly: true },
            );
            try {
              const sessions = database
                .prepare<[], { search_params: string }>(
                  "SELECT search_params FROM search_sessions",
                )
                .all();
              assert.equal(sessions.length, 6);
              for (const row of sessions) {
                const params: unknown = JSON.parse(row.search_params);
                assert.partialDeepStrictEqual(params, {
                  status: ["COMPLETED", "RECRUITING"],
                });
              }
            } finally {
              database.close();
            }
          },
          { CLINICAL_TRIALS_API_BASE_URL: baseUrl },
        );
      },
    );
  },
);

test(
  "MCP limits API operations, removes queued cancellation, releases failures, and isolates sessions",
  { timeout: 20_000 },
  async (t) => {
    const fourStarted = barrier();
    const replacementStarted = barrier();
    const held = new Map<string, import("node:http").ServerResponse>();
    const requests: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const reply = (query: string, status = 200) => {
      const response = held.get(query);
      assert.ok(response, `Missing held response for ${query}`);
      held.delete(query);
      active -= 1;
      if (status !== 200) response.writeHead(status).end();
      else
        response.end(
          JSON.stringify({
            studies: [
              {
                protocolSection: {
                  identificationModule: {
                    nctId:
                      query === "replacement"
                        ? "NCT00000009"
                        : `NCT0000000${query.slice(-1)}`,
                    briefTitle: query,
                  },
                  statusModule: { overallStatus: "RECRUITING" },
                },
              },
            ],
          }),
        );
    };
    await withHttpStub(
      (request, response) => {
        const query =
          new URL(request.url ?? "/", "http://localhost").searchParams
            .get("query.term")
            ?.slice(1, -1) ?? "";
        requests.push(query);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        held.set(query, response);
        if (requests.length === 4) fourStarted.resolve();
        if (query === "replacement") replacementStarted.resolve();
      },
      async (baseUrl) => {
        await withStdioClient(
          "modern",
          async (client, runtimeDirectory, transport) => {
            // Observe transport writes so the protocol barrier follows both queued calls.
            const fifthSent = barrier();
            const sixthSent = barrier();
            let sent = 0;
            const send = transport.send.bind(transport);
            t.mock.method(
              transport,
              "send",
              async (...args: Parameters<typeof transport.send>) => {
                await send(...args);
                if ("method" in args[0] && args[0].method === "tools/call") {
                  sent += 1;
                  if (sent === 5) fifthSent.resolve();
                  if (sent === 6) sixthSent.resolve();
                }
              },
            );
            const call = (query: string, signal?: AbortSignal) =>
              client.callTool(
                { name: "search_trials", arguments: { query } },
                { signal, timeout: 5_000 },
              );
            const initial = [1, 2, 3, 4].map((i) => call(`held${i}`));
            // Attach rejection handlers before any assertion can fail.
            const allInitial = Promise.all(initial);
            void allInitial.catch(() => {});
            await bounded(fourStarted.promise);
            const controller = new AbortController();
            const cancelled = call("cancelled", controller.signal);
            const cancellation = assert.rejects(cancelled, /cancel queued/);
            void cancellation.catch(() => {});
            const replacement = call("replacement");
            void replacement.catch(() => {});
            await bounded(Promise.all([fifthSent.promise, sixthSent.promise]));
            await client.listTools(undefined, {
              cacheMode: "refresh",
              timeout: 5_000,
            });
            assert.equal(requests.length, 4);
            controller.abort(new Error("cancel queued"));
            await cancellation;
            await client.listTools(undefined, {
              cacheMode: "refresh",
              timeout: 5_000,
            });
            assert.equal(requests.length, 4);
            reply("held1", 400);
            await bounded(replacementStarted.promise);
            const failed = await initial[0];
            assert.equal(failed?.isError, true);
            assert.match(JSON.stringify(failed?.content), /HTTP 400/);
            assert.equal(requests.includes("cancelled"), false);
            assert.equal(maximumActive, 4);
            reply("replacement");
            for (const query of ["held2", "held3", "held4"]) reply(query);
            const success = await replacement;
            assert.notEqual(success.isError, true);
            const results = await allInitial;
            for (const result of results.slice(1))
              assert.notEqual(result.isError, true);
            const sessionId = (result: typeof success) => {
              const id = JSON.stringify(result.content).match(
                /\*\*Session ID:\*\* ([0-9a-f-]{36})/,
              )?.[1];
              assert.ok(id);
              return id;
            };
            const replacementId = sessionId(success);
            const otherId = sessionId(results[1]!);
            assert.notEqual(replacementId, otherId);
            const refined = await client.callTool({
              name: "refine_results",
              arguments: { sessionId: replacementId, hasResults: true },
            });
            assert.notEqual(refined.isError, true);
            const database = new Database(
              path.join(runtimeDirectory, "data", "clinical-trials.db"),
              { readonly: true },
            );
            try {
              const ids = database.prepare<[string], { nct_id: string }>(
                "SELECT nct_id FROM session_results WHERE session_id = ? ORDER BY position",
              );
              assert.deepEqual(ids.all(replacementId), []);
              assert.deepEqual(ids.all(otherId), [{ nct_id: "NCT00000002" }]);
              const sessions = database
                .prepare<[], { search_params: string }>(
                  "SELECT search_params FROM search_sessions",
                )
                .all();
              assert.equal(sessions.length, 4);
              assert.ok(
                sessions.every(
                  (row) => !/cancelled|held1/.test(row.search_params),
                ),
              );
              assert.equal(
                fs
                  .readdirSync(path.join(runtimeDirectory, "cache"))
                  .filter((name) => /^search(?:Upstream|AllV2):/.test(name))
                  .length,
                4,
              );
            } finally {
              database.close();
            }
            assert.deepEqual(requests.slice(0, 4).sort(), [
              "held1",
              "held2",
              "held3",
              "held4",
            ]);
            assert.deepEqual(requests.slice(4), ["replacement"]);
          },
          { CLINICAL_TRIALS_API_BASE_URL: baseUrl },
        );
      },
    );
  },
);

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const detailStudy = (title: string) => ({
  protocolSection: {
    identificationModule: { nctId: "NCT00000009", briefTitle: title },
    statusModule: { overallStatus: "RECRUITING" },
  },
});

function setUpstream(root: string, body: unknown, status = 200): void {
  fs.writeFileSync(
    path.join(root, "upstream.json"),
    JSON.stringify({ body, status }),
  );
}

function seedDetails(root: string, updatedAt: string): void {
  const database = new Database(path.join(root, "data", "clinical-trials.db"));
  try {
    database
      .prepare(
        "INSERT INTO studies (nct_id, brief_title, raw_json, updated_at, fetched_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "NCT00000009",
        "Stored title",
        JSON.stringify(detailStudy("Stored title")),
        updatedAt,
        "2000-01-01 00:00:00",
      );
  } finally {
    database.close();
  }
}

test("refreshes stale details using updated_at and reuses the refreshed study", async () => {
  await withStdioClient(
    "modern",
    async (client, root) => {
      seedDetails(root, "2001-01-01 00:00:00");
      setUpstream(root, detailStudy("Fresh title"));
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "NCT00000009" },
        });
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /Fresh title/);
      }
      assert.equal(
        fs.readFileSync(path.join(root, "requests"), "utf8"),
        "request\n",
      );
    },
    true,
  );
});

test("warns with the stored UTC date when refresh fails; missing details return the error", async () => {
  await withStdioClient(
    "modern",
    async (client, root) => {
      seedDetails(root, "2001-01-01 00:00:00");
      setUpstream(root, {}, 400);
      const stale = await client.callTool({
        name: "get_trial_details",
        arguments: { nctId: "NCT00000009" },
      });
      assert.notEqual(stale.isError, true);
      assert.match(
        JSON.stringify(stale.content),
        /Warning: could not refresh from ClinicalTrials.gov; showing data stored 2001-01-01 00:00:00 UTC/,
      );
      assert.match(JSON.stringify(stale.content), /Stored title/);
      const missing = await client.callTool({
        name: "get_trial_details",
        arguments: { nctId: "NCT00000008" },
      });
      assert.equal(missing.isError, true);
      assert.match(JSON.stringify(missing.content), /HTTP 400/);
    },
    true,
  );
});

test("keeps fresh updated_at details even when fetched_at is old", async () => {
  await withStdioClient(
    "modern",
    async (client, root) => {
      seedDetails(
        root,
        new Date().toISOString().slice(0, 19).replace("T", " "),
      );
      const result = await client.callTool({
        name: "get_trial_details",
        arguments: { nctId: "NCT00000009" },
      });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result.content), /Stored title/);
      assert.equal(fs.existsSync(path.join(root, "requests")), false);
    },
    true,
  );
});

test("replaces synthetic fetchAll totals and warns on fresh and cached capped searches", async () => {
  await withStdioClient(
    "modern",
    async (client, root) => {
      const params = {
        condition: "cap-test",
        fetchAll: true,
        fetchLimit: 1,
        pageSize: 1000,
      };
      const key = createHash("sha256")
        .update(JSON.stringify(params))
        .digest("hex");
      fs.writeFileSync(
        path.join(root, "cache", `searchUpstream:${key}.json`),
        JSON.stringify({
          params,
          timestamp: Date.now(),
          data: { studies: [detailStudy("Old cache")], totalCount: 1 },
        }),
      );
      setUpstream(root, {
        studies: [detailStudy("Fresh title")],
        totalCount: 50,
        nextPageToken: "next",
      });
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({
          name: "search_trials",
          arguments: { condition: "cap-test", fetchAll: true, fetchLimit: 1 },
        });
        assert.notEqual(result.isError, true);
        assert.match(
          JSON.stringify(result.content),
          /1 of 50 studies \(stopped at fetchLimit 1\)\. Raise fetchLimit or narrow the search/,
        );
        assert.doesNotMatch(JSON.stringify(result.content), /first page only/);
      }
      assert.equal(
        fs.readFileSync(path.join(root, "requests"), "utf8"),
        "request\n",
      );
    },
    true,
  );
});

test("a complete fetchAll keeps its total without a limit warning", async () => {
  await withStdioClient(
    "modern",
    async (client, root) => {
      setUpstream(root, { studies: [detailStudy("Complete")], totalCount: 1 });
      const result = await client.callTool({
        name: "search_trials",
        arguments: { fetchAll: true, fetchLimit: 2 },
      });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result.content), /Search found 1 study/);
      assert.doesNotMatch(JSON.stringify(result.content), /stopped|first page/);
    },
    true,
  );
});

test(
  "cancelling a stale detail refresh stops fetch and leaves the stored timestamp unchanged",
  { timeout: 5000 },
  async () => {
    await withStdioClient(
      "modern",
      async (client, root) => {
        seedDetails(root, "2001-01-01 00:00:00");
        fs.writeFileSync(
          path.join(root, "upstream.json"),
          JSON.stringify({ body: detailStudy("Cancelled"), delayMs: 2000 }),
        );
        const controller = new AbortController();
        const pending = client.callTool(
          { name: "get_trial_details", arguments: { nctId: "NCT00000009" } },
          { signal: controller.signal },
        );
        const rejected = assert.rejects(pending, /cancel/i);
        const deadline = Date.now() + 2000;
        while (
          !fs.existsSync(path.join(root, "requests")) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(fs.existsSync(path.join(root, "requests")));
        controller.abort(new Error("test cancellation"));
        await rejected;
        const abortDeadline = Date.now() + 2000;
        while (
          !fs.existsSync(path.join(root, "aborted")) &&
          Date.now() < abortDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(fs.existsSync(path.join(root, "aborted")));
        const database = new Database(
          path.join(root, "data", "clinical-trials.db"),
        );
        try {
          assert.deepEqual(
            database
              .prepare("SELECT updated_at FROM studies WHERE nct_id = ?")
              .get("NCT00000009"),
            { updated_at: "2001-01-01 00:00:00" },
          );
        } finally {
          database.close();
        }
      },
      true,
    );
  },
);

test("restoring a missing study preserves its cache age on disk and memory hits", async () => {
  await withStdioClient("modern", async (client, root) => {
    const params = { pageSize: 1000, query: "restore-age" };
    const key = createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex");
    const timestamp = Date.now() - 23 * 60 * 60 * 1000;
    const updatedAt = new Date(timestamp)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    fs.writeFileSync(
      path.join(root, "cache", `searchUpstream:${key}.json`),
      JSON.stringify({
        params,
        timestamp,
        data: { studies: [detailStudy("Cached title")], totalCount: 1 },
      }),
    );
    const database = new Database(
      path.join(root, "data", "clinical-trials.db"),
    );
    try {
      for (let i = 0; i < 2; i++) {
        const result = await client.callTool({
          name: "search_trials",
          arguments: { query: "restore-age" },
        });
        assert.notEqual(result.isError, true);
        assert.deepEqual(
          database
            .prepare("SELECT updated_at FROM studies WHERE nct_id = ?")
            .get("NCT00000009"),
          { updated_at: updatedAt },
        );
        database
          .prepare("DELETE FROM studies WHERE nct_id = ?")
          .run("NCT00000009");
      }
    } finally {
      database.close();
    }
  });
});
