import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const serverEntry = path.join(projectRoot, "dist", "mcp", "server.js");
const mockUpstreamEntry = path.join(
  projectRoot,
  "tools",
  "regression",
  "mock-upstream.mjs",
);
const runRoot = path.join(projectRoot, ".tmp", "regression");
const expectedTools = [
  "search_trials",
  "refine_results",
  "get_trial_details",
  "summarize_session",
  "export_results",
];

interface LoggedRequest {
  method: string;
  url: string;
  event?: "request" | "response";
  attempt?: number;
  scenario?: string;
  activeRequests?: number;
}

interface ToolResultLike {
  content?: unknown;
  isError?: boolean;
}

function resultText(result: ToolResultLike): string {
  assert.ok(Array.isArray(result.content), "tool result must contain content");
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function sessionIdFrom(result: ToolResultLike): string {
  const match = resultText(result).match(
    /\*\*Session ID:\*\* ([0-9a-f-]{36})/i,
  );
  assert.ok(match?.[1], "search result must contain a session ID");
  return match[1];
}

function readRequests(requestLog: string): LoggedRequest[] {
  if (!fs.existsSync(requestLog)) return [];
  return fs
    .readFileSync(requestLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest)
    .filter((entry) => entry.event !== "response");
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  await run();
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`✓ ${name} (${elapsed}ms)`);
}

function createTransport(
  runtimeDirectory: string,
  requestLog: string,
  stderrLog: string,
  mocked: boolean,
): StdioClientTransport {
  const args = mocked
    ? ["--import", mockUpstreamEntry, serverEntry]
    : [serverEntry];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: runtimeDirectory,
    env: mocked
      ? {
          ...getDefaultEnvironment(),
          CLINICAL_TRIALS_REGRESSION_REQUEST_LOG: requestLog,
        }
      : getDefaultEnvironment(),
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk: Buffer | string) => {
    fs.appendFileSync(stderrLog, chunk);
  });
  return transport;
}

async function runDeterministic(
  runtimeDirectory: string,
  requestLog: string,
  stderrLog: string,
): Promise<void> {
  const transport = createTransport(
    runtimeDirectory,
    requestLog,
    stderrLog,
    true,
  );
  const client = new Client(
    { name: "clinical-trials-regression", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);

    await check("serves the expected modern MCP tool surface", async () => {
      assert.equal(client.getProtocolEra(), "modern");
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        expectedTools,
      );
    });

    let cachedSessionId = "";
    await check(
      "searches, persists, and reuses the response cache",
      async () => {
        const searchArguments = {
          condition: "diabetes",
          status: "recruiting",
          pageSize: 3,
        };
        const first = await client.callTool({
          name: "search_trials",
          arguments: searchArguments,
        });
        assert.notEqual(first.isError, true);
        assert.match(resultText(first), /Search found 3 studies/);
        const firstSessionId = sessionIdFrom(first);

        const requestsAfterFirstSearch = readRequests(requestLog);
        assert.equal(requestsAfterFirstSearch.length, 1);
        const firstUrl = new URL(requestsAfterFirstSearch[0]!.url);
        assert.equal(
          firstUrl.searchParams.get("query.term"),
          "AREA[ConditionSearch]diabetes",
        );
        assert.equal(
          firstUrl.searchParams.get("filter.overallStatus"),
          "RECRUITING",
        );
        assert.equal(firstUrl.searchParams.get("countTotal"), "true");

        const second = await client.callTool({
          name: "search_trials",
          arguments: searchArguments,
        });
        assert.notEqual(second.isError, true);
        cachedSessionId = sessionIdFrom(second);
        assert.notEqual(cachedSessionId, firstSessionId);
        assert.equal(readRequests(requestLog).length, 1);

        const database = new Database(
          path.join(runtimeDirectory, "data", "clinical-trials.db"),
          { readonly: true },
        );
        try {
          const studyCount = database
            .prepare("SELECT COUNT(*) AS count FROM studies")
            .get() as { count: number };
          const sessionCount = database
            .prepare("SELECT COUNT(*) AS count FROM search_sessions")
            .get() as { count: number };
          assert.equal(studyCount.count, 3);
          assert.equal(sessionCount.count, 2);
        } finally {
          database.close();
        }
        assert.ok(fs.existsSync(path.join(runtimeDirectory, "cache")));
      },
    );

    await check(
      "paginates fetchAll searches up to the requested limit",
      async () => {
        const before = readRequests(requestLog).length;
        const result = await client.callTool({
          name: "search_trials",
          arguments: {
            query: "pagination-regression",
            pageSize: 2,
            fetchAll: true,
            fetchLimit: 3,
          },
        });
        assert.notEqual(result.isError, true);
        assert.match(resultText(result), /Search found 3 studies/);
        assert.equal(readRequests(requestLog).length - before, 2);
      },
    );

    await check(
      "keeps distinct search parameters in separate cache entries",
      async () => {
        const before = readRequests(requestLog).length;
        const firstArguments = {
          query: "cache-identity-regression",
          pageSize: 2,
        };
        const secondArguments = { ...firstArguments, pageSize: 3 };

        const first = await client.callTool({
          name: "search_trials",
          arguments: firstArguments,
        });
        assert.notEqual(first.isError, true);
        assert.match(resultText(first), /Search found 2 studies/);

        const second = await client.callTool({
          name: "search_trials",
          arguments: secondArguments,
        });
        assert.notEqual(second.isError, true);
        assert.match(resultText(second), /Search found 3 studies/);
        assert.equal(readRequests(requestLog).length - before, 2);

        for (const arguments_ of [firstArguments, secondArguments]) {
          const cached = await client.callTool({
            name: "search_trials",
            arguments: arguments_,
          });
          assert.notEqual(cached.isError, true);
        }
        assert.equal(readRequests(requestLog).length - before, 2);
      },
    );

    await check(
      "bounds concurrent upstream searches and creates independent sessions",
      async () => {
        const before = readRequests(requestLog).length;
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            client.callTool({
              name: "search_trials",
              arguments: {
                query: `concurrency-regression-${index + 1}`,
                pageSize: 1,
              },
            }),
          ),
        );
        const sessionIds = results.map((result) => {
          assert.notEqual(result.isError, true);
          assert.match(resultText(result), /Search found 1 study/);
          return sessionIdFrom(result);
        });
        assert.equal(new Set(sessionIds).size, 6);

        const concurrentRequests = readRequests(requestLog)
          .slice(before)
          .filter((request) => request.scenario === "concurrency");
        assert.equal(concurrentRequests.length, 6);
        const maxActive = Math.max(
          ...concurrentRequests.map((request) => request.activeRequests ?? 0),
        );
        assert.ok(maxActive > 1, "searches should overlap upstream work");
        assert.ok(maxActive <= 4, "API operation limit must remain at four");
      },
    );

    await check(
      "retries transient upstream failures and returns terminal MCP errors",
      async () => {
        const before = readRequests(requestLog).length;
        const retried = await client.callTool({
          name: "search_trials",
          arguments: { query: "retry-429-regression", pageSize: 1 },
        });
        assert.notEqual(retried.isError, true);
        assert.match(resultText(retried), /Search found 1 study/);

        const afterRetry = readRequests(requestLog);
        const retryRequests = afterRetry
          .slice(before)
          .filter((request) => request.scenario === "retry-429");
        assert.equal(retryRequests.length, 2);
        assert.deepEqual(
          retryRequests.map((request) => request.attempt),
          [1, 2],
        );

        const terminal = await client.callTool({
          name: "search_trials",
          arguments: { query: "retry-503-terminal-regression", pageSize: 1 },
        });
        assert.equal(terminal.isError, true);
        assert.match(
          resultText(terminal),
          /Request failed after 3 attempts: HTTP 503/,
        );

        const terminalRequests = readRequests(requestLog)
          .slice(afterRetry.length)
          .filter((request) => request.scenario === "retry-503-terminal");
        assert.equal(terminalRequests.length, 3);
        assert.deepEqual(
          terminalRequests.map((request) => request.attempt),
          [1, 2, 3],
        );
      },
    );

    await check(
      "returns MCP errors for malformed and schema-invalid upstream payloads",
      async () => {
        const before = readRequests(requestLog).length;
        const malformed = await client.callTool({
          name: "search_trials",
          arguments: { query: "malformed-json-regression", pageSize: 1 },
        });
        assert.equal(malformed.isError, true);
        assert.match(resultText(malformed), /^Error:/);

        const schemaInvalidSearch = await client.callTool({
          name: "search_trials",
          arguments: { query: "schema-invalid-search-regression", pageSize: 1 },
        });
        assert.equal(schemaInvalidSearch.isError, true);
        assert.match(
          resultText(schemaInvalidSearch),
          /failed schema validation/i,
        );

        const schemaInvalidDetail = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "NCT00000005", includeEligibility: false },
        });
        assert.equal(schemaInvalidDetail.isError, true);
        assert.match(
          resultText(schemaInvalidDetail),
          /failed schema validation/i,
        );

        const invalidRequests = readRequests(requestLog).slice(before);
        assert.deepEqual(
          invalidRequests.map((request) => request.scenario),
          ["malformed-json", "schema-invalid-search", "schema-invalid-detail"],
        );
      },
    );

    await check("keeps refinements cumulative and local", async () => {
      const before = readRequests(requestLog).length;
      const first = await client.callTool({
        name: "refine_results",
        arguments: {
          sessionId: cachedSessionId,
          studyType: "INTERVENTIONAL",
        },
      });
      assert.notEqual(first.isError, true);
      assert.match(resultText(first), /Filtered from 3 to 2 studies/);

      const second = await client.callTool({
        name: "refine_results",
        arguments: { sessionId: cachedSessionId, masking: "DOUBLE" },
      });
      assert.notEqual(second.isError, true);
      assert.match(resultText(second), /Filtered from 2 to 1 study/);

      const summary = await client.callTool({
        name: "summarize_session",
        arguments: { sessionId: cachedSessionId, maxResults: 10 },
      });
      const summaryText = resultText(summary);
      assert.match(summaryText, /NCT00000001/);
      assert.doesNotMatch(summaryText, /NCT00000003/);
      assert.equal(readRequests(requestLog).length, before);
    });

    await check(
      "uses the API once for uncached details, then SQLite",
      async () => {
        const before = readRequests(requestLog).length;
        const first = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "NCT00000004", includeEligibility: false },
        });
        assert.notEqual(first.isError, true);
        assert.match(resultText(first), /Detail-only regression study/);
        assert.equal(readRequests(requestLog).length, before + 1);

        const second = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "NCT00000004", includeEligibility: false },
        });
        assert.notEqual(second.isError, true);
        assert.equal(readRequests(requestLog).length, before + 1);
      },
    );

    await check(
      "exports the refined session in every supported format",
      async () => {
        for (const format of ["csv", "json", "jsonl"] as const) {
          const result = await client.callTool({
            name: "export_results",
            arguments: {
              sessionId: cachedSessionId,
              format,
              outputPath: `regression.${format}`,
            },
          });
          assert.notEqual(result.isError, true);
          const destination = path.join(
            runtimeDirectory,
            "exports",
            format,
            `regression.${format}`,
          );
          assert.ok(fs.statSync(destination).size > 0);
        }
      },
    );

    await check(
      "returns MCP errors for invalid and missing resources",
      async () => {
        const invalidId = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "not-an-nct-id" },
        });
        assert.equal(invalidId.isError, true);

        const missingSession = await client.callTool({
          name: "summarize_session",
          arguments: { sessionId: "missing-session" },
        });
        assert.equal(missingSession.isError, true);
        assert.match(resultText(missingSession), /not found/i);

        const missingStudy = await client.callTool({
          name: "get_trial_details",
          arguments: { nctId: "NCT99999999" },
        });
        assert.equal(missingStudy.isError, true);
        assert.match(resultText(missingStudy), /HTTP 404/);
      },
    );
  } finally {
    await client.close().catch(() => undefined);
  }

  const restartedTransport = createTransport(
    runtimeDirectory,
    requestLog,
    stderrLog,
    true,
  );
  const restartedClient = new Client(
    { name: "clinical-trials-regression-restarted", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await restartedClient.connect(restartedTransport);
    await check(
      "reuses the disk cache after an MCP server restart",
      async () => {
        const before = readRequests(requestLog).length;
        const result = await restartedClient.callTool({
          name: "search_trials",
          arguments: {
            condition: "diabetes",
            status: "recruiting",
            pageSize: 3,
          },
        });
        assert.notEqual(result.isError, true);
        assert.match(resultText(result), /Search found 3 studies/);
        assert.equal(readRequests(requestLog).length, before);
      },
    );
  } finally {
    await restartedClient.close().catch(() => undefined);
  }

  const legacyDirectory = path.join(runtimeDirectory, "legacy");
  fs.mkdirSync(legacyDirectory);
  const legacyTransport = createTransport(
    legacyDirectory,
    requestLog,
    stderrLog,
    true,
  );
  const legacyClient = new Client({
    name: "clinical-trials-regression-legacy",
    version: "1.0.0",
  });
  try {
    await legacyClient.connect(legacyTransport);
    await check("continues to negotiate with legacy MCP clients", async () => {
      assert.equal(legacyClient.getProtocolEra(), "legacy");
      const { tools } = await legacyClient.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        expectedTools,
      );
    });
  } finally {
    await legacyClient.close().catch(() => undefined);
  }
}

async function runLive(
  runtimeDirectory: string,
  requestLog: string,
  stderrLog: string,
): Promise<void> {
  const transport = createTransport(
    runtimeDirectory,
    requestLog,
    stderrLog,
    false,
  );
  const client = new Client(
    { name: "clinical-trials-regression-live", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );

  try {
    await client.connect(transport);
    await check("searches the live ClinicalTrials.gov API", async () => {
      const search = await client.callTool({
        name: "search_trials",
        arguments: { query: "NCT00000102", pageSize: 1 },
      });
      assert.notEqual(search.isError, true);
      assert.match(resultText(search), /Search found 1 study/);

      const summary = await client.callTool({
        name: "summarize_session",
        arguments: { sessionId: sessionIdFrom(search), maxResults: 1 },
      });
      assert.notEqual(summary.isError, true);
      assert.match(resultText(summary), /NCT00000102/);
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const live = process.argv.includes("--live");
  fs.mkdirSync(runRoot, { recursive: true });
  const runtimeDirectory = fs.mkdtempSync(
    path.join(runRoot, live ? "live-" : "run-"),
  );
  const requestLog = path.join(runtimeDirectory, "upstream-requests.jsonl");
  const stderrLog = path.join(runtimeDirectory, "server.stderr.log");
  let succeeded = false;

  console.log(
    `${live ? "Live smoke test" : "Deterministic regression"} runtime: ${runtimeDirectory}`,
  );

  try {
    if (live) {
      await runLive(runtimeDirectory, requestLog, stderrLog);
    } else {
      await runDeterministic(runtimeDirectory, requestLog, stderrLog);
    }
    succeeded = true;
    console.log("Regression harness passed.");
  } finally {
    if (succeeded && !keep) {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    } else {
      console.log(`Preserved regression artifacts: ${runtimeDirectory}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
