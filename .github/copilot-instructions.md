# Copilot Instructions - Clinical Trials MCP Server

## Architecture Overview

**MCP Server Interface:** Model Context Protocol server for AI assistants using shared core library.

**On-Demand Data Model:** No full database download. Studies fetched and cached only when searched. Database grows organically (hundreds, not millions).

**Iterative Refinement Workflow:**
```
Search (API) → Session + Cache → Filter (local) → Filter (local) → Export
```
Sessions store NCT IDs for filtering cached results without API re-queries.

## Critical Patterns

### 1. ESM Import Convention (TypeScript)
```typescript
// ALWAYS use .js extension for imports (ESM requirement)
import { db } from '../db/database.js';  // ✓ Correct
import { db } from '../db/database';    // ✗ Wrong - compilation fails
```

### 2. Singleton Services
```typescript
// src/db/database.ts, src/utils/cache.ts, src/api/client.ts
export const db = new DatabaseManager();
export const cache = new CacheManager();
export const apiClient = new ClinicalTrialsAPIClient();

// Import and use directly (no instantiation)
import { db } from '../db/database.js';
db.upsertStudy(study);
```

### 3. Upsert Pattern for Studies
```sql
INSERT INTO studies (...) VALUES (...)
ON CONFLICT(nct_id) DO UPDATE SET ... -- Update if exists
```
Database accepts both new and updated trial data.

### 4. Three-Layer Storage
- **Memory Cache:** 1min TTL (instant re-queries)
- **Disk Cache:** 24hr TTL + JSONL audit trail (preserves raw API responses)
- **SQLite:** Normalized schema with FTS5 search + session management

### 5. Session-Based Refinement
Every search creates session with search params + NCT ID list. Filters work on sessions without API calls.
```typescript
const sessionId = generateSessionId(); // session_1234567890_abc123
db.createSession(sessionId, searchParams, nctIds);
```

## ClinicalTrials.gov API Specifics

**Query Syntax:** `AREA[FieldName]query` combined with AND
```typescript
// Example: "AREA[ConditionSearch]diabetes AND AREA[LocationSearch]California"
```

**Status Filter:** Must be UPPERCASE (e.g., `RECRUITING`, not `recruiting`)
```typescript
urlParams.set('filter.overallStatus', params.status.toUpperCase());
```

**Retry Logic:** 3 attempts with exponential backoff (1s, 2s, 4s) in `fetchWithRetry()`

**Pagination:** Max 1000 per page. Use `pageToken` for next page. Set `countTotal=true` for total count.

## Key Files & Responsibilities

- **[src/api/client.ts](src/api/client.ts):** API client with retry logic, query building, Zod validation
- **[src/db/database.ts](src/db/database.ts):** SQLite manager with FTS5, sessions, upsert logic
- **[src/utils/cache.ts](src/utils/cache.ts):** Two-tier cache (memory + disk), JSONL raw backup
- **[src/utils/helpers.ts](src/utils/helpers.ts):** `filterStudies()`, `formatStudySummary()`, `generateSessionId()`
- **[src/models/types.ts](src/models/types.ts):** Zod schemas for API responses + TypeScript types
- **[src/mcp/server.ts](src/mcp/server.ts):** 5 MCP tools (search, refine, details, summarize, export)

## Database Schema Essentials

**Core Tables:**
- `studies` - Main table with `raw_json` column (full API response) + normalized fields
- `conditions`, `interventions`, `locations`, `keywords` - Many-to-many relations
- `search_sessions` + `session_results` - Session management for refinement

**Full-Text Search:** `studies_fts` virtual table (FTS5) indexes title, summary, description. Auto-synced via triggers.

**Indexes:** Status, phase, start_date on studies; condition, country, state on related tables.

## Common Development Tasks

### Adding MCP Tool
1. Add tool definition in `ListToolsRequestSchema` handler
2. Add case in `CallToolRequestSchema` handler  
3. Return `{ content: [{ type: 'text', text: '...' }] }` or `{ ..., isError: true }`

### Adding Filter
1. Add to `FilterParams` interface in [types.ts](src/models/types.ts)
2. Update `filterStudies()` in [helpers.ts](src/utils/helpers.ts)
3. Add to MCP `refine_results` inputSchema

### Adding Export Format
1. Create function in [export.ts](src/utils/export.ts)
2. Add to `ExportFormat` type in [types.ts](src/models/types.ts)
3. Add case in MCP server handler

## Error Handling Conventions

- **API Client:** Auto-retry with exponential backoff (no user intervention)
- **MCP:** Return error in `content` array with `isError: true` flag

## Development Commands

```bash
npm run build           # Compile TypeScript (src/ → dist/)
npm run dev             # Watch mode compilation
node dist/mcp/server.js # MCP server (stdio, for Claude Desktop)
sqlite3 data/clinical-trials.db ".tables"  # Inspect database
```

## Debugging Tips

**Database locked:** Close other connections or `rm -rf data/`  
**MCP not in Claude:** Check absolute path in `claude_desktop_config.json`, rebuild, restart Claude  
**Empty results:** Verify API accessible, check cache files in `cache/` directory  
**TS errors:** Verify `.js` extensions on imports, Zod schemas match API shape

## Performance Notes

- **Fast (<100ms):** Cache hits, indexed SQLite queries, session filtering
- **Moderate (1-5s):** First API search, database upserts, FTS queries
- **Slow (>5s):** Paginated searches (multiple API calls), large exports

## Remember

1. **Always `.js` extension** on TypeScript imports (ESM)
2. **Uppercase status filters** for API (`RECRUITING` not `recruiting`)
3. **Sessions enable refinement** without API re-queries
4. **Upsert pattern** handles new + updated trials
5. **No full download** - data loaded on demand only
