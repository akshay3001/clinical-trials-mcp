# Clinical Trials MCP Server

Search and analyze clinical trial data from ClinicalTrials.gov through an MCP
server.

The stdio server supports MCP `2026-07-28` and legacy clients.

## Prerequisites

- Node.js 24 or newer

## Installation

```bash
npm ci
npm run build
npm test
```

## Usage

### MCP Server

Add to your `mcp.json`:

```json
{
  "mcpServers": {
    "clinical-trials": {
      "command": "node",
      "args": ["/path/to/clinical-trials/dist/mcp/server.js"]
    }
  }
}
```

## Features

- 🔍 **Advanced Search**: Search by condition, intervention, sponsor, location, phase, status, or general terms
- 🎯 **Iterative Refinement**: Filter results without re-querying the API
- 🤖 **MCP Integration**: Connect AI assistants through MCP
- 💾 **Smart Caching**: In-memory and disk caching to minimize API calls
- 📊 **Flexible Export**: CSV, JSON, JSONL formats
- 🗄️ **Local Database**: SQLite storage with full-text search
- 🔌 **Current MCP Protocol**: Modern `2026-07-28` with legacy compatibility

### Iterative Refinement

The tool creates sessions that allow you to refine searches without hitting the API again:

1. Initial search hits API and stores results
2. Search and filter operations return compact counts plus a session ID
3. Filter operations work on cached results
4. Call `summarize_session` for study summaries, or `export_results` for the complete result set
5. Session persists in the local database with a sliding seven-day lifetime

`search_trials` and `refine_results` do not include a study list in their responses. For example:

```text
Filtered from 1,000 to 174 studies.
**Session ID:** 550e8400-e29b-41d4-a716-446655440000
```

### Smart Caching

- **Memory cache**: 1 minute TTL for instant repeated queries
- **Disk cache**: 24 hour TTL for persistence
- **Raw JSONL**: Complete API responses saved for debugging

### Full-Text Search

The SQLite database includes full-text search indexes on:

- Study titles
- Summaries
- Detailed descriptions

### Data Export

Export in multiple formats:

- **CSV**: Ready for Excel/Google Sheets with key columns
- **JSON**: Full nested structure preserved
- **JSONL**: One study per line for streaming/processing

Exports are confined to `./exports` and never overwrite an existing file. Set
`CLINICAL_TRIALS_EXPORTS_DIR` to choose a different allowed export root. Relative
paths must remain beneath that root; absolute paths are accepted only when they
already point inside it.

Large paginated searches are bounded to 10,000 studies and 100 API pages. Set
`fetchLimit` to a smaller total when using `fetchAll`; it cannot exceed
`pageSize × 100`.

## Local Regression Harness

Run the deterministic end-to-end regression harness after changing MCP tool
behavior, API/cache logic, persistence, refinement, or exports:

```bash
npm run regression
```

The harness builds and launches the compiled stdio server in an isolated
temporary directory, replaces ClinicalTrials.gov requests with committed
fixtures, and exercises search, caching, pagination, sessions, cumulative
refinement, details, exports, errors, and modern/legacy protocol negotiation.
It does not use the network or the normal `data/`, `cache/`, or `exports/`
directories.

Successful runs clean up automatically. `npm run regression:keep` preserves a
successful run under `.tmp/regression/`; failed runs are always preserved there
for debugging. Use `npm run regression:live` only when you explicitly want a
small network-dependent smoke test against ClinicalTrials.gov.

## Architecture

- **Core API Client**: Handles ClinicalTrials.gov API v2 communication
- **Database Layer**: SQLite with normalized schema and full-text search
- **Caching**: Two-tier caching (memory + disk) for performance
- **MCP Server**: Model Context Protocol interface for AI assistants

## License

MIT
