# AGENTS.md

## Scope

These instructions apply to the entire repository. Keep this file focused on durable project conventions; user-facing setup and feature documentation belongs in `README.md`.

## Project overview

This is a TypeScript MCP server that searches the ClinicalTrials.gov API v2, caches responses, persists studies in SQLite, supports session-based local refinement, and exports results as CSV, JSON, or JSONL.

The data model is intentionally on demand. Do not add a full ClinicalTrials.gov database download unless the task explicitly requires a fundamental architecture change.

The main request flow is:

```text
MCP tool call -> API/cache -> SQLite upsert -> search session -> local refinement/export
```

## Runtime and commands

- Use Node.js 24, 25, or 26. The upper bound follows the `better-sqlite3` engines range. CI currently runs Node.js 24.
- Install exactly from the lockfile with `npm ci`.
- Build with `npm run build`.
- Run the compiled stdio server with `npm run start:mcp`.
- Use `npm run dev` for TypeScript watch mode.
- Format source files with `npm run format`.
- Check formatting without changing files with `npx prettier --check "src/**/*.ts"`.
- There is currently no automated test suite or lint script. `prompts.md` contains manual MCP scenarios; use relevant scenarios when behavior changes.

Before finishing a code change, run at minimum:

```bash
npm run build
npx prettier --check "src/**/*.ts"
```

If MCP behavior changed, also launch the compiled server or exercise the relevant scenario from `prompts.md`. State clearly when network-dependent behavior was not exercised.

## Repository map

- `src/mcp/server.ts`: stdio MCP entry point, tool schemas, and tool dispatch.
- `src/api/client.ts`: ClinicalTrials.gov API v2 query construction, pagination, validation, and retries.
- `src/db/database.ts`: SQLite schema, migrations, study upserts, FTS5, and search sessions.
- `src/models/types.ts`: Zod schemas and shared TypeScript types.
- `src/utils/cache.ts`: one-minute memory cache, 24-hour disk cache, and raw JSONL response log.
- `src/utils/helpers.ts`: in-memory refinement filters and Markdown result formatting.
- `src/utils/export.ts`: CSV, JSON, and JSONL serialization and output-path handling.
- `prompts.md`: manual end-to-end MCP scenarios and expected flows.
- `README.md`: concise user-facing installation and feature overview.
- `dist/`, `data/`, `cache/`, and `exports/`: generated runtime artifacts; they are ignored and must not be committed.

## Architecture invariants

### ESM and TypeScript

- The package uses ESM (`"type": "module"`). Relative TypeScript imports must include the emitted `.js` extension, for example `../models/types.js`.
- Keep strict TypeScript compilation clean, including unused symbol, implicit return, and switch fallthrough checks.
- Prefer typed values and Zod validation at external boundaries. Existing `any` use is not a pattern to extend without a concrete need.
- ClinicalTrials.gov schemas use `.passthrough()` deliberately so new upstream fields do not break otherwise valid responses.

### MCP stdio behavior

- Standard output is reserved for MCP protocol messages. Send diagnostics to standard error with `console.error`; never add `console.log` in the server path.
- Tool failures must be returned as MCP content with `isError: true` rather than escaping the request handler.
- When adding or changing a tool, keep its advertised `inputSchema`, argument typing, dispatch case, result text, README/manual examples, and shared types in sync.
- `search_trials` creates a session. `refine_results` filters the current session results locally and replaces that session's result set; refinements are cumulative.

### API and caching

- Use `https://clinicaltrials.gov/api/v2` through `ClinicalTrialsAPIClient`; do not scatter direct API calls across MCP handlers.
- Build specialized searches with the API's `AREA[...]` syntax. Put each query part in parentheses, for example `AREA[ConditionSearch](x)`, and combine the parts with `AND`. Essie binds `AND` tighter than `OR`, so an ungrouped part changes the meaning of the query.
- Send `filter.overallStatus` as a comma-separated list of API status enum values. Take status input as a list of those values, because a display label such as "Active, not recruiting" contains a comma.
- API pages are limited to 1,000 studies. Preserve `pageToken` pagination and the distinction between a single page and `fetchAll`.
- The API client retries failed requests up to three attempts with exponential delays.
- A search checks the cache before the API, saves raw API responses, writes the returned studies, and then creates a session. A fresh API response upserts every study. A cache hit only inserts studies that are missing (`insertStudyIfMissing`), because a cached response can be older than a stored study; never upsert a stored study from the cache. Changes to search parameters must also account for cache-key identity and persisted session parameters.

### Storage and sessions

- `apiClient`, `db`, and `cache` are exported singleton instances. Import and reuse them; do not create competing instances in application code.
- Importing the database and cache modules creates their runtime directories, and database initialization runs schema migration/backfill logic. Avoid importing these modules in tooling that is expected to be side-effect free.
- SQLite is the durable local store. `studies.raw_json` preserves the full upstream study while selected fields and related tables support filtering and export.
- Study writes use an upsert keyed by `nct_id`. When adding a persisted field, update table creation, migration/backfill, the upsert insert and conflict-update clauses, parameter extraction, indexes if appropriate, and any related filters/types.
- Sessions store NCT IDs, not duplicate study payloads. Refinement must not make another upstream API request.
- Preserve SQLite WAL mode, foreign-key enforcement, cascading relationships, and FTS synchronization.
- One-time data migrations are gated by `PRAGMA user_version` and run in a transaction: version 1 rebuilds the FTS triggers and index, version 2 repairs the denormalized columns from `raw_json`. Give a new one-time migration the next version and run the migrations in version order.

### Exports

- CSV always contains the core columns; optional columns are defined by `AdditionalExportColumn` and `ADDITIONAL_COLUMN_EXTRACTORS`.
- Adding a CSV column requires synchronized changes in the shared union type, extractor map, and MCP tool enum.
- CSV serializers use the literal `BLANK` for absent values. JSON and JSONL preserve the upstream study shape from `studies.raw_json`, including missing fields, empty arrays, null, `0`, and `false`. Study schemas must not add defaults. Reject JSON/JSONL exports of legacy rows without a matching `raw_json_upstream_hash`; a fresh search replaces them. Use the `searchUpstream` cache namespace to exclude older responses with defaults.
- A bare output filename is organized under `exports/<format>/`; an absolute path or a path containing directories is honored as supplied.

## Change recipes

### Add a refinement filter

1. Add it to `FilterParams` in `src/models/types.ts`.
2. Implement it in `filterStudies()` in `src/utils/helpers.ts`.
3. Advertise it in the `refine_results` input schema in `src/mcp/server.ts`.
4. Add or update a representative scenario in `prompts.md`.

Be explicit about missing upstream data, case normalization, array matching semantics, and whether bounds are inclusive. Do not compare numeric ages as raw strings; normalize units before adding or revising age-range behavior.

### Add an MCP tool

1. Add the tool definition to the `ListToolsRequestSchema` handler.
2. Add its dispatch case to the `CallToolRequestSchema` handler.
3. Reuse the API, database, cache, and formatting layers instead of duplicating their logic.
4. Return MCP text content and use the common error contract.
5. Document and manually exercise the new workflow.

### Change the upstream study schema

Update the Zod schema first, keep optional upstream modules optional, and verify both search responses and single-study details. If the field is persisted, filtered, or exported, follow the storage and export synchronization rules above.

## Working practices

- Keep changes scoped and preserve unrelated work in the tree.
- Do not commit generated databases, cache contents, exports, compiled output, logs, or dependency directories.
- Do not delete `data/` as a routine debugging step; it may contain a developer's local study cache and sessions. If a destructive reset is genuinely needed, ask first.
- Treat exported study data as potentially sensitive user output even though the upstream registry is public: avoid printing large payloads or contact details in diagnostics.
- Update this file when a change introduces a durable command, invariant, or cross-cutting workflow. Avoid turning it into a feature catalog or copying the MCP tool reference here.
