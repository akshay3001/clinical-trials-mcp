# GitHub Copilot Instructions - Clinical Trials MCP Server

## Project Overview

This is a **Clinical Trials data extraction and analysis tool** that provides both:
1. **MCP (Model Context Protocol) Server** for AI assistants like Claude Desktop
2. **CLI (Command Line Interface)** for direct terminal usage

Both interfaces share the same core library for searching, filtering, and exporting clinical trial data from ClinicalTrials.gov API v2.

## Technology Stack

- **Language**: TypeScript (compiled to JavaScript/ESM)
- **Runtime**: Node.js (ES Modules)
- **Database**: SQLite via better-sqlite3
- **API**: ClinicalTrials.gov API v2 (REST, no auth required)
- **Validation**: Zod schemas
- **CLI**: Commander.js
- **CSV Export**: PapaParse
- **MCP SDK**: @modelcontextprotocol/sdk

## Project Structure

```
src/
├── api/
│   └── client.ts           # ClinicalTrials.gov API client with retry logic
├── db/
│   └── database.ts         # SQLite manager with session support
├── mcp/
│   └── server.ts          # MCP server with 5 tools for AI assistants
├── cli/
│   └── index.ts           # CLI commands (search, filter, export, etc.)
├── models/
│   └── types.ts           # TypeScript types & Zod schemas
└── utils/
    ├── cache.ts           # Two-tier caching (memory + disk)
    ├── export.ts          # CSV/JSON/JSONL export functions
    └── helpers.ts         # Filtering, formatting, session utilities
```

## Core Architecture Patterns

### 1. On-Demand Data Loading
- **No full database download** on startup
- Data fetched **only when searched**
- Database grows organically based on user queries
- Typical database: few hundred studies, not 500,000+

### 2. Iterative Refinement Workflow
```
Initial Search (API call) → Session Created → Results Cached
    ↓
Filter #1 (local query) → Session Updated → No API call
    ↓
Filter #2 (local query) → Session Updated → No API call
    ↓
Export → Read from session → Generate file
```

### 3. Three-Layer Data Storage

**Layer 1: API Response Cache**
- In-memory: 1 minute TTL
- Disk: 24 hour TTL  
- JSONL backup: Raw API responses preserved

**Layer 2: SQLite Database**
- Normalized schema (studies, conditions, interventions, locations)
- Full-text search index (FTS5)
- Session management for refinement
- Fast queries and filtering

**Layer 3: Export Files**
- Organized in `exports/` folder by format
- CSV/JSON/JSONL options
- Generated only when requested

### 4. Hybrid Storage Strategy

**SQLite for:**
- Fast queries and filtering
- Relational data (conditions, locations)
- Full-text search
- Session persistence

**JSONL for:**
- Complete API response preservation
- No schema constraints
- Debugging and audit trail

**CSV/JSON for:**
- Final export only (not storage)
- User-facing data sharing

## Key Design Decisions

### 1. Singleton Pattern for Database & Cache
```typescript
// database.ts
export const db = new DatabaseManager();

// Usage everywhere:
import { db } from '../db/database.js';
db.upsertStudy(study);
```

**Why:** Single connection, consistent state, automatic initialization.

### 2. Session-Based Refinement
Every search creates a session ID that stores:
- Original search parameters
- List of NCT IDs (study identifiers)
- Timestamp for cleanup

**Why:** Enables filtering cached results without re-querying API.

### 3. Upsert Pattern for Studies
```typescript
INSERT INTO studies (...) VALUES (...)
ON CONFLICT(nct_id) DO UPDATE SET ...
```

**Why:** Handles both new trials and updates to existing ones.

### 4. Export Path Organization
```typescript
// Simple filename → Auto-organized
exportToCSV(studies, 'diabetes.csv')
// → ./exports/csv/diabetes.csv

// Full path → Respected
exportToCSV(studies, '/path/to/file.csv')
// → /path/to/file.csv
```

**Why:** Clean workspace, easy to find files, still flexible.

## Important Conventions

### File Imports
Always use `.js` extension for TypeScript imports (ESM requirement):
```typescript
// Correct
import { db } from '../db/database.js';

// Wrong
import { db } from '../db/database';
```

### Error Handling
- API client: Exponential backoff retry (3 attempts)
- CLI: Exit with code 1 on error, display user-friendly message
- MCP: Return error in content with `isError: true`

### Async/Await
Use async/await throughout, not callbacks or raw promises:
```typescript
// Correct
const study = await apiClient.getStudy(nctId);

// Avoid
apiClient.getStudy(nctId).then(study => { ... });
```

### Type Safety
- All API responses validated with Zod schemas
- Strong typing throughout (no `any` except for external data)
- Use type assertions carefully: `as unknown as Type`

## Database Schema Quick Reference

**Main Tables:**
- `studies` - Core trial data + raw JSON blob
- `conditions` - Many-to-many with studies
- `interventions` - Many-to-many with studies  
- `locations` - Many-to-many with studies
- `keywords` - Many-to-many with studies
- `search_sessions` - Session metadata
- `session_results` - Many-to-many sessions ↔ studies

**Key Indexes:**
- Status, phase, start_date on studies
- Condition, country, state, city on related tables
- Full-text search on `studies_fts` virtual table

## ClinicalTrials.gov API Notes

**Base URL:** `https://clinicaltrials.gov/api/v2`

**Key Endpoints:**
- `GET /studies` - Search trials
- `GET /studies/{nctId}` - Get specific trial
- `GET /version` - API version and data timestamp
- `GET /stats/size` - Database statistics

**Search Areas (19 total):**
- `BasicSearch` - General (default)
- `ConditionSearch` - Diseases
- `InterventionSearch` - Treatments
- `LocationSearch` - Geographic
- And 15 more...

**Query Syntax:**
```
AREA[FieldName]query
Example: AREA[ConditionSearch]diabetes AND AREA[LocationSearch]California
```

**Rate Limits:**
- None documented
- Be respectful: 1-2 requests/second recommended
- Caching minimizes API calls

**Pagination:**
- Max pageSize: 1000
- Use pageToken for next page
- Set countTotal=true for total count

## Common Tasks

### Adding a New MCP Tool
1. Add tool definition in `server.setRequestHandler(ListToolsRequestSchema, ...)`
2. Add case in `server.setRequestHandler(CallToolRequestSchema, ...)`
3. Implement logic using existing utilities
4. Return result in `{ content: [{ type: 'text', text: '...' }] }` format

### Adding a New CLI Command
1. Add command in `src/cli/index.ts` using `.command()`
2. Add options with `.option()` or `.requiredOption()`
3. Implement `.action()` handler
4. Use try/catch, exit with code 1 on error

### Adding a New Filter
1. Add property to `FilterParams` in `types.ts`
2. Update `filterStudies()` in `helpers.ts`
3. Add to MCP tool `refine_results` inputSchema
4. Add to CLI `filter` command options

### Adding a New Export Format
1. Create export function in `export.ts`
2. Update `ExportFormat` type in `types.ts`
3. Add case in MCP server and CLI export handlers
4. Ensure it uses `getExportPath()` for organization

## Testing Approach

**Manual Testing Commands:**
```bash
# Build
npm run build

# Test CLI
node dist/cli/index.js stats
node dist/cli/index.js search --condition "diabetes" --status "Recruiting"

# Test MCP (requires Claude Desktop setup)
# See claude_desktop_config.example.json
```

**Database Inspection:**
```bash
sqlite3 data/clinical-trials.db ".tables"
sqlite3 data/clinical-trials.db "SELECT COUNT(*) FROM studies;"
```

## Code Style Guidelines

### Naming
- Files: kebab-case (`clinical-trials.db`)
- Classes: PascalCase (`DatabaseManager`)
- Functions: camelCase (`upsertStudy`)
- Constants: UPPER_SNAKE_CASE (`DEFAULT_DB_PATH`)

### Comments
- JSDoc for public functions
- Inline comments for complex logic
- Explain "why" not "what"

### Function Size
- Keep functions focused and small
- Extract complex logic into utilities
- Maximum ~50 lines per function

## Performance Considerations

**Fast Operations (<100ms):**
- Memory cache hits
- Disk cache hits
- SQLite queries with indexes
- Session result filtering

**Moderate Operations (1-5s):**
- First API search
- Storing 100 studies in database
- Full-text search across thousands

**Slow Operations (>5s):**
- Paginated searches (multiple API calls)
- Exporting thousands of studies
- Cold start API calls with retries

## Security Notes

- No authentication required for ClinicalTrials.gov API
- No user credentials stored
- All data is public clinical trial information
- SQLite database is local (no remote access)
- Cache files contain public data only

## Future Enhancement Ideas

When extending this project, consider:
- Refresh command to update stale data
- Background sync for monitoring trials
- AI-powered summarization (optional, requires API keys)
- Geographic visualization with maps
- Trend analysis across time
- Comparison tools for multiple trials
- Web interface (React/Next.js)
- GraphQL API layer

## Troubleshooting Tips

**"Database is locked" error:**
- Close other connections to the database
- Check for zombie processes
- Delete database and recreate: `rm -rf data/`

**MCP server not appearing in Claude:**
- Verify absolute path in `claude_desktop_config.json`
- Ensure project is built: `npm run build`
- Restart Claude Desktop completely
- Check logs: `~/Library/Logs/Claude/`

**TypeScript compilation errors:**
- Ensure `.js` extensions on all imports
- Check Zod schema matches API response
- Verify `as unknown as Type` for complex casts

**Empty search results:**
- Check if ClinicalTrials.gov API is accessible
- Verify search parameters are valid
- Check cache hasn't corrupted: `clinicaltrials clear-cache`

## File Extension Context

When working on this project, remember:
- `.ts` files are TypeScript source (in `src/`)
- `.js` files are compiled output (in `dist/`)
- `.db` files are SQLite databases (in `data/`)
- `.jsonl` files are cache backups (in `cache/`)
- `.csv/.json` files are exports (in `exports/`)

## Quick Reference Commands

```bash
# Development
npm install          # Install dependencies
npm run build       # Compile TypeScript
npm run dev         # Watch mode compilation

# CLI Usage
node dist/cli/index.js search --condition "diabetes"
node dist/cli/index.js filter --session <id> --country "USA"
node dist/cli/index.js export --session <id> --format csv --output file.csv
node dist/cli/index.js stats
node dist/cli/index.js clear-cache

# Database
sqlite3 data/clinical-trials.db ".tables"
sqlite3 data/clinical-trials.db "SELECT * FROM studies LIMIT 5;"

# MCP Server
node dist/mcp/server.js  # Runs on stdio (used by Claude Desktop)
```

## Remember

1. **Data is lazy-loaded** - never assume full dataset is available
2. **Sessions enable refinement** - always create sessions on search
3. **Cache expires** - 1 min memory, 24hr disk
4. **Exports are organized** - auto-creates `exports/{format}/` folders
5. **Database is local** - grows based on user searches, not full download
6. **MCP and CLI share code** - changes to core affect both interfaces

This is a research tool designed for flexibility, performance, and ease of use by both humans (CLI) and AI assistants (MCP).
