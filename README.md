# Clinical Trials MCP Server

Extract and analyze clinical trial data from ClinicalTrials.gov with AI-powered search and summarization.

## Installation

```bash
npm install
npm run build
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

- 🔍 **Advanced Search**: Search across 19 specialized areas (conditions, interventions, locations, etc.)
- 🎯 **Iterative Refinement**: Filter results without re-querying the API
- 🤖 **AI Integration**: MCP server for conversational access through MCP Client
- 💾 **Smart Caching**: In-memory and disk caching to minimize API calls
- 📊 **Flexible Export**: CSV, JSON, JSONL formats
- 🗄️ **Local Database**: SQLite storage with full-text search

### Iterative Refinement

The tool creates sessions that allow you to refine searches without hitting the API again:

1. Initial search hits API and stores results
2. Filter operations work on cached results
3. Session persists in database for future access

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

## Architecture

- **Core API Client**: Handles ClinicalTrials.gov API v2 communication
- **Database Layer**: SQLite with normalized schema and full-text search
- **Caching**: Two-tier caching (memory + disk) for performance
- **MCP Server**: Model Context Protocol interface for AI assistants
- **CLI**: Command-line interface for direct usage

## License

MIT
