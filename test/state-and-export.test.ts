import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import type { Study } from "../src/models/types.js";

const originalWorkingDirectory = process.cwd();
const runtimeDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "clinical-trials-state-test-"),
);
process.chdir(runtimeDirectory);

const [{ DatabaseManager, db }, exportModule, helperModule] = await Promise.all(
  [
    import("../src/db/database.js"),
    import("../src/utils/export.js"),
    import("../src/utils/helpers.js"),
  ],
);

test.after(() => {
  db.close();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(runtimeDirectory, { recursive: true, force: true });
});

test("uses opaque UUID session handles and preserves valid empty sessions", () => {
  const databasePath = path.join(runtimeDirectory, "isolated", "sessions.db");
  const database = new DatabaseManager(databasePath, 1_000);
  const sessionId = helperModule.generateSessionId();

  try {
    assert.match(
      sessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    database.createSession(sessionId, { condition: "diabetes" }, []);
    assert.equal(database.sessionExists(sessionId), true);
    assert.equal(database.getSessionMetadata(sessionId)?.resultCount, 0);
    assert.deepEqual(database.getSessionResults(sessionId), []);
    assert.equal(database.updateSessionResults("missing", []), false);

    database.cleanupExpiredSessions(Date.now() + 2_000);
    assert.equal(database.sessionExists(sessionId), false);
  } finally {
    database.close();
  }
});

test("migrates active sessions created before expiry metadata existed", () => {
  const databasePath = path.join(runtimeDirectory, "legacy", "sessions.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacyDatabase = new Database(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE search_sessions (
      session_id TEXT PRIMARY KEY,
      search_params TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO search_sessions (session_id, search_params)
    VALUES ('legacy-session', '{"condition":"diabetes"}');
  `);
  legacyDatabase.close();

  const migratedDatabase = new DatabaseManager(databasePath);
  try {
    const metadata = migratedDatabase.getSessionMetadata("legacy-session");
    assert.ok(metadata);
    assert.deepEqual(metadata.searchParams, { condition: "diabetes" });
    assert.ok(Date.parse(metadata.expiresAt) > Date.now());
  } finally {
    migratedDatabase.close();
  }
});

test("confines exports, preserves JSON falsy values, and refuses overwrite", async () => {
  const exportRoot = path.join(runtimeDirectory, "safe-exports");
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = exportRoot;

  const studies = [{ zero: 0, enabled: false, empty: "" } as unknown as Study];
  const destination = await exportModule.exportToJSON(studies, "results.json");
  const exported = JSON.parse(fs.readFileSync(destination, "utf8")) as Array<{
    zero: number;
    enabled: boolean;
    empty: string;
  }>;

  assert.equal(
    path.dirname(destination),
    path.join(fs.realpathSync(exportRoot), "json"),
  );
  assert.deepEqual(exported, [{ zero: 0, enabled: false, empty: "BLANK" }]);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  await assert.rejects(
    exportModule.exportToJSON(studies, "results.json"),
    /Refusing to overwrite/,
  );
  assert.throws(
    () => exportModule.getExportPath("../escape.json", "json"),
    /must remain within/,
  );
  assert.throws(
    () =>
      exportModule.getExportPath(path.join(os.tmpdir(), "escape.json"), "json"),
    /must remain within/,
  );
});

test("rejects export symlink escapes and protects CSV consumers", async () => {
  const exportRoot = path.join(runtimeDirectory, "csv-exports");
  const outside = path.join(runtimeDirectory, "outside");
  fs.mkdirSync(exportRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(exportRoot, "linked"));
  process.env.CLINICAL_TRIALS_EXPORTS_DIR = exportRoot;

  assert.throws(
    () => exportModule.getExportPath("linked/escape.csv", "csv"),
    /symbolic links/,
  );

  const study = {
    protocolSection: {
      identificationModule: {
        nctId: "NCT00000001",
        briefTitle: '=HYPERLINK("https://example.test")',
      },
      statusModule: { overallStatus: "RECRUITING" },
    },
  } as Study;
  const destination = await exportModule.exportToCSV([study], "safe.csv");
  assert.match(fs.readFileSync(destination, "utf8"), /'=HYPERLINK/);
});
