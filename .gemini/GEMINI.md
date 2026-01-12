# Clinical Trials MCP Server - Context for Gemini

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

**Default Page Size:** 1000 (changed from 100 for better results coverage). MCP server supports `fetchAll` parameter to automatically paginate through all results.

## Project Structure

```
clinical-trials/
├── src/
│   ├── api/
│   │   └── client.ts          # API client with retry, query building, Zod validation
│   ├── db/
│   │   └── database.ts        # SQLite manager with FTS5, sessions, upsert logic
│   ├── mcp/
│   │   └── server.ts          # MCP server with 5 tools
│   ├── models/
│   │   └── types.ts           # Zod schemas + TypeScript types
│   └── utils/
│       ├── cache.ts           # Two-tier cache (memory + disk), JSONL backup
│       ├── export.ts          # Export functions (CSV, JSON, JSONL)
│       └── helpers.ts         # filterStudies(), formatStudySummary(), generateSessionId()
├── data/
│   └── clinical-trials.db     # SQLite database (auto-created)
├── cache/                      # Disk cache directory (auto-created)
├── exports/                    # Export outputs directory
└── dist/                       # Compiled TypeScript output
```

## Key Files & Responsibilities

- **src/api/client.ts:** API client with retry logic, query building, Zod validation
- **src/db/database.ts:** SQLite manager with FTS5, sessions, upsert logic
- **src/utils/cache.ts:** Two-tier cache (memory + disk), JSONL raw backup
- **src/utils/helpers.ts:** `filterStudies()`, `formatStudySummary()`, `generateSessionId()`
- **src/models/types.ts:** Zod schemas for API responses + TypeScript types
- **src/mcp/server.ts:** 5 MCP tools (search, refine, details, summarize, export)
  - `search_trials`: Default pageSize=1000, optional `fetchAll=true` for complete pagination

## MCP Tools Available

1. **search_trials** - Search ClinicalTrials.gov API, create session
   - Default pageSize: 1000 (up to 1000 results per search)
   - Optional `fetchAll: true` - Automatically paginate through ALL results (may take longer)
2. **refine_results** - Filter session results locally (25+ filter options)
3. **get_trial_details** - Fetch detailed trial information
4. **summarize_session** - Get formatted summary of session results
5. **export_results** - Export to CSV, JSON, or JSONL

## Database Schema Essentials

**Core Tables:**
- `studies` - Main table with `raw_json` column (full API response) + normalized fields
- `conditions`, `interventions`, `locations`, `keywords` - Many-to-many relations
- `search_sessions` + `session_results` - Session management for refinement

**Full-Text Search:** `studies_fts` virtual table (FTS5) indexes title, summary, description. Auto-synced via triggers.

**Indexes:** Status, phase, start_date on studies; condition, country, state on related tables.

## Common Development Tasks

### Adding MCP Tool
1. Add tool definition in `ListToolsRequestSchema` handler in src/mcp/server.ts
2. Add case in `CallToolRequestSchema` handler  
3. Return `{ content: [{ type: 'text', text: '...' }] }` or `{ ..., isError: true }`

### Adding Filter
1. Add to `FilterParams` interface in src/models/types.ts
2. Update `filterStudies()` in src/utils/helpers.ts
3. Add to MCP `refine_results` inputSchema in src/mcp/server.ts

### Adding Export Format
1. Create function in src/utils/export.ts
2. Add to `ExportFormat` type in src/models/types.ts
3. Add case in MCP server handler in src/mcp/server.ts

## Error Handling Conventions

- **API Client:** Auto-retry with exponential backoff (no user intervention)
- **MCP:** Return error in `content` array with `isError: true` flag

## Development Commands

```bash
npm run build           # Compile TypeScript (src/ → dist/)
npm run dev             # Watch mode compilation
node dist/mcp/server.js # Run MCP server (stdio mode)
sqlite3 data/clinical-trials.db ".tables"  # Inspect database
```

## Debugging Tips

**Database locked:** Close other connections or `rm -rf data/`  
**MCP connection issues:** Check `.gemini/settings.json` configuration, rebuild with `npm run build`, restart Gemini CLI  
**Empty results:** Verify API accessible at https://clinicaltrials.gov/api/v2/, check cache files in `cache/` directory  
**TypeScript errors:** Verify `.js` extensions on imports, ensure Zod schemas match API response shape  

## Performance Characteristics

- **Fast (<100ms):** Cache hits, indexed SQLite queries, session filtering
- **Moderate (1-5s):** First API search (up to 1000 results), database upserts, FTS queries
- **Slow (>5s):** `fetchAll=true` searches (multiple API calls for >1000 results), large exports

## Important Rules & Conventions

1. **Always `.js` extension** on TypeScript imports (ESM requirement)
2. **Uppercase status filters** for API (`RECRUITING` not `recruiting`)
3. **Sessions enable refinement** without API re-queries
4. **Upsert pattern** handles new + updated trials seamlessly
5. **Default 1000 results** - use `fetchAll=true` for complete datasets (slower but comprehensive)
6. **No full download** - data loaded on demand only
7. **Singleton pattern** for db, cache, and apiClient - import and use directly
8. **Raw JSON preserved** in `raw_json` column for debugging and future schema changes

## Future Enhancements (Not Yet Implemented)

- `get_stats` MCP tool - ClinicalTrials.gov API metadata and statistics
- `clear_cache` MCP tool - Cache management functionality
