import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer, type RequestListener } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClinicalTrialsAPIClient } from "../src/api/client.js";
import { DatabaseManager } from "../src/db/database.js";
import { StudySchema, type Study } from "../src/models/types.js";
import { CacheManager } from "../src/utils/cache.js";

const study = (nctId: string, briefTitle: string): Study =>
  StudySchema.parse({
    protocolSection: {
      identificationModule: { nctId, briefTitle },
      statusModule: { overallStatus: "RECRUITING" },
      conditionsModule: { conditions: ["Diabetes"], keywords: ["metabolic"] },
      designModule: { studyType: "INTERVENTIONAL" },
    },
    upstreamStudyField: { retained: true },
  });

async function startApiServer(handler: RequestListener): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("retries 429 and 5xx responses, while preserving validated upstream fields", async () => {
  const requests = new Map<string, number>();
  const api = await startApiServer((request, response) => {
    const query = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).searchParams.get("query.term");
    const attempts = (requests.get(query ?? "") ?? 0) + 1;
    requests.set(query ?? "", attempts);

    if ((query === "retry-429" || query === "retry-5xx") && attempts === 1) {
      response.writeHead(query === "retry-429" ? 429 : 503).end("retry");
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        studies: [study("NCT00000011", "Resilient study")],
        totalCount: 1,
        upstreamResponseField: "preserved",
      }),
    );
  });
  const client = new ClinicalTrialsAPIClient(api.baseUrl);

  try {
    for (const query of ["retry-429", "retry-5xx"]) {
      const response = await client.search({ query, pageSize: 10 });
      assert.equal(requests.get(query), 2);
      assert.equal(response.upstreamResponseField, "preserved");
      assert.deepEqual(
        (response.studies[0] as Study & { upstreamStudyField: unknown })
          .upstreamStudyField,
        { retained: true },
      );
    }
  } finally {
    await api.close();
  }
});

test("rejects malformed API payloads and honors request timeouts", async () => {
  const api = await startApiServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/studies/NCT00000015") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ protocolSection: {} }));
      return;
    }
    const query = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).searchParams.get("query.term");
    if (query === "malformed") {
      response.setHeader("content-type", "application/json");
      response.end("null");
      return;
    }
    if (query === "malformed-study") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ studies: [{ protocolSection: {} }] }));
      return;
    }

    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ studies: [] }));
    }, 500);
  });
  const client = new ClinicalTrialsAPIClient(api.baseUrl);

  try {
    await assert.rejects(
      client.search({ query: "malformed", pageSize: 10 }),
      /search response failed schema validation/,
    );
    await assert.rejects(
      client.search({ query: "malformed-study", pageSize: 10 }),
      /search response failed schema validation/,
    );
    await assert.rejects(
      client.getStudy("NCT00000015"),
      /study response failed schema validation/,
    );
    await assert.rejects(
      client.search({ query: "slow", pageSize: 10 }, { timeoutMs: 20 }),
      /timeout|aborted/i,
    );
    await assert.rejects(
      client.search({ pageSize: 10 }, { timeoutMs: 0 }),
      /positive finite number/,
    );
  } finally {
    await api.close();
  }
});

test("rejects invalid pagination bounds and repeated page tokens without looping", async () => {
  let requestCount = 0;
  const api = await startApiServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        studies: [study("NCT00000012", "Paged study")],
        nextPageToken: "same-token",
      }),
    );
  });
  const client = new ClinicalTrialsAPIClient(api.baseUrl);

  const consume = async (maxPages?: number, maxResults?: number) => {
    for await (const _batch of client.searchAll(
      { pageSize: 10 },
      { maxPages, maxResults },
    )) {
      // Consume the generator to exercise its guardrails.
    }
  };

  try {
    await assert.rejects(consume(0), /maxPages must be a positive integer/);
    await assert.rejects(
      consume(undefined, 0),
      /maxResults must be a positive integer/,
    );
    assert.equal(requestCount, 0);

    await assert.rejects(consume(3), /repeated page token/);
    assert.equal(requestCount, 2);
  } finally {
    await api.close();
  }
});

test("reuses disk cache, retains falsy values, and cleans only invalid or expired cache entries", () => {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinical-trials-cache-"),
  );
  const params = { condition: "diabetes", pageSize: 10 };
  const cache = new CacheManager(cacheDir);

  try {
    cache.set("answer", params, false);
    assert.equal(cache.get("answer", params), false);
    assert.equal(new CacheManager(cacheDir).get("answer", params), false);

    cache.set("expired", params, "old");
    const expiredFile = fs
      .readdirSync(cacheDir)
      .map((file) => path.join(cacheDir, file))
      .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).data === "old");
    assert.ok(expiredFile);
    fs.writeFileSync(
      expiredFile,
      JSON.stringify({
        data: "old",
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    const assertInvalidDiskEntry = (prefix: string, content: string) => {
      cache.set(prefix, params, prefix);
      const file = fs
        .readdirSync(cacheDir)
        .map((name) => path.join(cacheDir, name))
        .find(
          (candidate) =>
            JSON.parse(fs.readFileSync(candidate, "utf8")).data === prefix,
        );
      assert.ok(file);
      fs.writeFileSync(file, content);
      assert.equal(new CacheManager(cacheDir).get(prefix, params), null);
      assert.equal(fs.existsSync(file), false);
    };
    assertInvalidDiskEntry("missing-data", "{}");
    assertInvalidDiskEntry(
      "invalid-timestamp",
      JSON.stringify({ data: "invalid-timestamp", timestamp: "not-a-number" }),
    );
    assertInvalidDiskEntry("invalid-json", "not json");
    const invalidSweepFiles = [
      path.join(cacheDir, "sweep-missing-data.json"),
      path.join(cacheDir, "sweep-invalid-timestamp.json"),
    ];
    fs.writeFileSync(invalidSweepFiles[0], "{}");
    fs.writeFileSync(
      invalidSweepFiles[1],
      JSON.stringify({ data: "invalid", timestamp: "not-a-number" }),
    );
    cache.saveRawResponse({ studies: [] }, params);

    new CacheManager(cacheDir).clearExpired();
    assert.equal(fs.existsSync(expiredFile), false);
    assert.deepEqual(
      invalidSweepFiles.map((file) => fs.existsSync(file)),
      [false, false],
    );
    assert.equal(
      fs.readdirSync(cacheDir).some((file) => file.startsWith("raw-")),
      true,
    );

    cache.clearAll();
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("updates persisted study search indexes and keeps session changes atomic", () => {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinical-trials-db-"),
  );
  const database = new DatabaseManager(path.join(runtimeDir, "state.db"));
  const nctId = "NCT00000013";

  try {
    database.upsertStudy(study(nctId, "Original persistent title"));
    assert.deepEqual(database.fullTextSearch("Original"), [nctId]);

    const persistedStudy = study(nctId, "Updated persistent title");
    database.upsertStudy(persistedStudy);
    assert.equal(
      database.getStudy(nctId)?.protocolSection.identificationModule.briefTitle,
      "Updated persistent title",
    );
    assert.deepEqual(database.fullTextSearch("Original"), []);
    assert.deepEqual(database.fullTextSearch("Updated"), [nctId]);

    const internal = database as unknown as { db: Database.Database };
    internal.db.exec(`
      CREATE TRIGGER fail_normalized_condition
      BEFORE INSERT ON conditions
      WHEN NEW.condition = 'Hypertension'
      BEGIN
        SELECT RAISE(ABORT, 'forced normalized relation failure');
      END;
    `);
    const failedUpdate = study(nctId, "Failed update must roll back");
    failedUpdate.protocolSection.conditionsModule = {
      conditions: ["Hypertension"],
      keywords: ["changed"],
    };
    assert.throws(
      () => database.upsertStudy(failedUpdate),
      /forced normalized relation failure/,
    );
    assert.deepEqual(database.getStudy(nctId), persistedStudy);
    assert.deepEqual(
      internal.db
        .prepare("SELECT condition FROM conditions WHERE nct_id = ?")
        .all(nctId),
      [{ condition: "Diabetes" }],
    );
    assert.deepEqual(database.fullTextSearch("Failed"), []);
    assert.deepEqual(database.fullTextSearch("Updated"), [nctId]);

    database.createSession("valid-session", { query: "original" }, [nctId]);
    assert.throws(
      () => database.createSession("invalid-session", {}, ["NCT99999999"]),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(database.sessionExists("invalid-session"), false);
    assert.throws(
      () => database.updateSessionResults("valid-session", ["NCT99999999"]),
      /FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(
      database
        .getSessionResults("valid-session")
        .map((result) => result.protocolSection.identificationModule.nctId),
      [nctId],
    );
  } finally {
    database.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("repairs legacy FTS triggers and rebuilds a stale external-content index", () => {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinical-trials-legacy-fts-"),
  );
  const databasePath = path.join(runtimeDir, "legacy.db");
  const nctId = "NCT00000014";
  const initial = new DatabaseManager(databasePath);

  try {
    initial.upsertStudy(study(nctId, "Stale searchable title"));
  } finally {
    initial.close();
  }

  const legacyDatabase = new Database(databasePath);
  const repairedStudy = study(nctId, "Rebuilt searchable title");
  legacyDatabase.exec(`
    DROP TRIGGER studies_ai;
    DROP TRIGGER studies_ad;
    DROP TRIGGER studies_au;
  `);
  legacyDatabase
    .prepare(
      "UPDATE studies SET brief_title = ?, raw_json = ? WHERE nct_id = ?",
    )
    .run("Rebuilt searchable title", JSON.stringify(repairedStudy), nctId);
  legacyDatabase.exec(`

    CREATE TRIGGER studies_ai AFTER INSERT ON studies BEGIN
      INSERT INTO studies_fts(rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
      VALUES (new.rowid, new.nct_id, new.brief_title, new.official_title, new.brief_summary, new.detailed_description);
    END;

    CREATE TRIGGER studies_ad AFTER DELETE ON studies BEGIN
      INSERT INTO studies_fts(studies_fts, rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
      VALUES ('delete', old.rowid, old.nct_id, old.brief_title, old.official_title, old.brief_summary, old.detailed_description);
    END;

    CREATE TRIGGER studies_au AFTER UPDATE ON studies BEGIN
      INSERT INTO studies_fts(studies_fts, rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
      VALUES ('delete', old.rowid, old.nct_id, old.brief_title, old.official_title, old.brief_summary, old.detailed_description);
      INSERT INTO studies_fts(rowid, nct_id, brief_title, official_title, brief_summary, detailed_description)
      VALUES (old.rowid, old.nct_id, old.brief_title, old.official_title, old.brief_summary, old.detailed_description);
    END;
  `);
  legacyDatabase.close();

  const repaired = new DatabaseManager(databasePath);
  try {
    assert.deepEqual(repaired.fullTextSearch("Stale"), []);
    assert.deepEqual(repaired.fullTextSearch("Rebuilt"), [nctId]);
  } finally {
    repaired.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("backfills nullable denormalized fields once across database reopens", () => {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clinical-trials-backfill-"),
  );
  const databasePath = path.join(runtimeDir, "backfill.db");
  const nctId = "NCT00000016";
  const initial = new DatabaseManager(databasePath);

  try {
    initial.upsertStudy(study(nctId, "Nullable denormalized fields"));
  } finally {
    initial.close();
  }

  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    DELETE FROM schema_migrations WHERE name = 'denormalized-fields-v1';
    CREATE TABLE study_update_audit (count INTEGER NOT NULL);
    INSERT INTO study_update_audit VALUES (0);
    CREATE TRIGGER count_backfill_study_updates AFTER UPDATE ON studies BEGIN
      UPDATE study_update_audit SET count = count + 1;
    END;
  `);
  legacyDatabase.close();

  const migrated = new DatabaseManager(databasePath);
  migrated.close();

  const afterMigration = new Database(databasePath);
  const firstCount = (
    afterMigration.prepare("SELECT count FROM study_update_audit").get() as {
      count: number;
    }
  ).count;
  afterMigration.close();
  assert.equal(firstCount, 1);

  const reopened = new DatabaseManager(databasePath);
  reopened.close();

  const afterReopen = new Database(databasePath);
  try {
    const secondCount = (
      afterReopen.prepare("SELECT count FROM study_update_audit").get() as {
        count: number;
      }
    ).count;
    assert.equal(secondCount, firstCount);
  } finally {
    afterReopen.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
