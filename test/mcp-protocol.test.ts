import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
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
  run: (client: Client, runtimeDirectory: string) => Promise<void>,
): Promise<void> {
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `clinical-trials-mcp-${mode}-`),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: runtimeDirectory,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "clinical-trials-mcp-test", version: "1.0.0" },
    mode === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : undefined,
  );

  try {
    await client.connect(transport);
    await run(client, runtimeDirectory);
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}

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
          "INSERT INTO studies (nct_id, brief_title, raw_json, raw_json_upstream) VALUES (?, ?, ?, 1)",
        )
        .run(
          "NCT00000001",
          "Seeded protocol test study",
          JSON.stringify(seededStudy),
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
