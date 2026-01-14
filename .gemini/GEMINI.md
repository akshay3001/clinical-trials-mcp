# Clinical Trials MCP Server - Usage Guide

This MCP server provides tools to search, filter, and explore clinical trials from ClinicalTrials.gov. Use the available tools to fulfill user requests - **do not modify code, only use the tools**.

## Purpose

Help users find relevant clinical trials by:
- Searching the ClinicalTrials.gov database
- Filtering and refining results
- Getting detailed trial information
- Summarizing and exporting results

---

## Available MCP Tools

### 1. `search_trials`
**Search for clinical trials using various criteria.**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `query` | General search across all fields | `"heart failure treatment"` |
| `condition` | Medical condition or disease | `"diabetes"`, `"breast cancer"`, `"COVID-19"` |
| `intervention` | Treatment or drug name | `"pembrolizumab"`, `"chemotherapy"` |
| `location` | Geographic location (country, state, city) | `"California"`, `"United States"` |
| `status` | Recruitment status | `"Recruiting"`, `"Completed"`, `"Active, not recruiting"` |
| `phase` | Trial phase | `"Phase 1"`, `"Phase 2"`, `"Phase 3"`, `"Phase 2\|Phase 3"` |
| `sponsorSearch` | Sponsor or organization | `"Pfizer"`, `"NIH"` |
| `pageSize` | Results per page (1-1000, default 100) | `100` |

**Returns:** Session ID for iterative refinement + initial results summary.

---

### 2. `refine_results`
**Filter existing search results without new API calls.**

Requires a `sessionId` from a previous `search_trials` call.

| Parameter | Description | Example |
|-----------|-------------|---------|
| `sessionId` | Session ID from search | `"session_1234567890_abc123"` |
| `locationCountry` | Filter by country | `"United States"` |
| `locationState` | Filter by state/province | `"California"` |
| `locationCity` | Filter by city | `"Los Angeles"` |
| `interventionType` | Type of intervention | `"Drug"`, `"Device"`, `"Biological"`, `"Behavioral"` |
| `enrollmentMin` | Minimum enrollment count | `100` |
| `enrollmentMax` | Maximum enrollment count | `500` |
| `startDateAfter` | Started after date | `"2023-01-01"` |
| `startDateBefore` | Started before date | `"2024-12-31"` |
| `hasResults` | Has posted results | `true` or `false` |

**Returns:** Filtered results from the session.

---

### 3. `get_trial_details`
**Get comprehensive information about a specific trial.**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `nctId` | NCT identifier of the trial | `"NCT12345678"` |
| `includeEligibility` | Include eligibility criteria (default: true) | `true` |

**Returns:** Full trial summary including eligibility, locations, contacts, and study design.

---

### 4. `summarize_session`
**Get a summary of all trials in a search session.**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `sessionId` | Session ID from search | `"session_1234567890_abc123"` |
| `maxResults` | Maximum results to show (default: 10) | `20` |

**Returns:** Concise summary with key details for each trial.

---

### 5. `export_results`
**Export search results to a file.**

| Parameter | Description | Example |
|-----------|-------------|---------|
| `sessionId` | Session ID to export | `"session_1234567890_abc123"` |
| `format` | Export format | `"csv"`, `"json"`, `"jsonl"` |
| `outputPath` | File path to save | `"./exports/diabetes-trials.csv"` |

**Returns:** Confirmation with file path and record count.

---

## Typical Workflow

```
1. search_trials     → Get initial results + session ID
2. refine_results    → Narrow down using filters (can repeat)
3. get_trial_details → Deep dive into specific trials
4. summarize_session → Overview of current results
5. export_results    → Save for external use
```

---

## Example Use Cases

### Find recruiting cancer trials in California
1. `search_trials` with `condition: "cancer"`, `status: "Recruiting"`, `location: "California"`
2. Use session ID to `refine_results` if needed
3. `get_trial_details` for promising trials

### Compare Phase 3 diabetes drug trials
1. `search_trials` with `condition: "diabetes"`, `phase: "Phase 3"`, `interventionType: "Drug"`
2. `summarize_session` for quick comparison
3. `export_results` to CSV for analysis

### Find trials by a specific sponsor
1. `search_trials` with `sponsorSearch: "Moderna"`
2. `refine_results` with `status: "Recruiting"` if only active trials needed

---

## Important Notes

- **Session-based workflow:** Each search creates a session. Use the session ID to filter/refine without hitting the API again.
- **Status values must be exact:** Use `"Recruiting"`, `"Completed"`, `"Active, not recruiting"`, `"Terminated"`, etc.
- **Combine phases with pipe:** `"Phase 2|Phase 3"` searches for both.
- **Results are cached:** Repeated searches for the same criteria are fast.
- **Use tools only:** This server is for querying clinical trials data, not for code modifications.
