# Test Prompts for Clinical Trials MCP Server

## Phase 1 - Simple Filters (DB Columns)

### 1. Study Type Filter
```
Search for observational studies on heart disease in California, then refine to only those accepting healthy volunteers
```

**Expected Flow:**
- `search_trials`: condition="heart disease", location="California"
- `refine_results`: sessionId="...", studyType="OBSERVATIONAL", healthyVolunteers=true

### 2. Sex & Sponsor Class Filter
```
Find industry-sponsored breast cancer trials for female participants only
```

**Expected Flow:**
- `search_trials`: condition="breast cancer"
- `refine_results`: sessionId="...", sex="FEMALE", sponsorClass="INDUSTRY"

### 3. Healthy Volunteers Filter
```
Show me NIH-funded interventional trials that accept healthy volunteers
```

**Expected Flow:**
- `search_trials`: query="NIH"
- `refine_results`: sessionId="...", studyType="INTERVENTIONAL", healthyVolunteers=true, sponsorClass="NIH"

---

## Phase 2 - Moderate Filters (Raw JSON Parsing)

### 4. Allocation & Intervention Model
```
Find randomized parallel-group trials for diabetes treatment
```

**Expected Flow:**
- `search_trials`: condition="diabetes", intervention="treatment"
- `refine_results`: sessionId="...", allocation="RANDOMIZED", interventionModel="PARALLEL"

### 5. Primary Purpose Filter
```
Search for COVID-19 prevention trials with participants aged 18-65
```

**Expected Flow:**
- `search_trials`: condition="COVID-19"
- `refine_results`: sessionId="...", primaryPurpose="PREVENTION", minAge="18 Years", maxAge="65 Years"

### 6. Age Range Filter
```
Show me cancer trials for elderly patients (65+) with crossover design
```

**Expected Flow:**
- `search_trials`: condition="cancer"
- `refine_results`: sessionId="...", minAge="65 Years", interventionModel="CROSSOVER"

---

## Phase 3 - Complex Filters (Array/Composite Logic)

### 7. Age Groups Array Matching
```
Find pediatric and adult asthma trials with double-blind masking
```

**Expected Flow:**
- `search_trials`: condition="asthma"
- `refine_results`: sessionId="...", ageGroups=["CHILD", "ADULT"], masking="DOUBLE"

### 8. FDA Regulated + Keyword
```
Search for FDA-regulated Alzheimer's trials with "biomarker" keyword
```

**Expected Flow:**
- `search_trials`: condition="Alzheimer's"
- `refine_results`: sessionId="...", fdaRegulated=true, keyword="biomarker"

### 9. Masking Filter
```
Find triple-blind randomized trials for hypertension treatment
```

**Expected Flow:**
- `search_trials`: condition="hypertension", intervention="treatment"
- `refine_results`: sessionId="...", masking="TRIPLE", allocation="RANDOMIZED"

---

## Multi-Step Refinement Workflows

### 10. Progressive Filtering
```
Search for diabetes trials, then narrow to:
1. Only recruiting studies with results posted
2. Industry-sponsored interventional trials
3. Randomized parallel design for adults only
4. Export final results to CSV
```

**Expected Flow:**
- `search_trials`: condition="diabetes"
- `refine_results`: sessionId="...", hasResults=true
- `refine_results`: sessionId="...", sponsorClass="INDUSTRY", studyType="INTERVENTIONAL"
- `refine_results`: sessionId="...", allocation="RANDOMIZED", interventionModel="PARALLEL", ageGroups=["ADULT"]
- `export_results`: sessionId="...", format="csv", outputPath="diabetes_trials.csv"

### 11. Complex Location + Demographics
```
Find cancer trials in New York for female patients aged 40-70, accepting healthy volunteers, with treatment purpose
```

**Expected Flow:**
- `search_trials`: condition="cancer", location="New York"
- `refine_results`: sessionId="...", locationState="New York", sex="FEMALE", minAge="40 Years", maxAge="70 Years", healthyVolunteers=true, primaryPurpose="TREATMENT"

### 12. Study Design Deep Dive
```
Search for Phase 3 cardiac trials, then filter to:
- FDA-regulated drug trials
- Quadruple-blind randomized design
- Enrollment between 100-500 participants
- Summarize top 5 results
```

**Expected Flow:**
- `search_trials`: condition="cardiac", phase="Phase 3"
- `refine_results`: sessionId="...", fdaRegulated=true, masking="QUADRUPLE", allocation="RANDOMIZED", enrollmentMin=100, enrollmentMax=500
- `summarize_session`: sessionId="...", maxResults=5

---

## Edge Cases & Validation

### 13. Invalid Enum Value (Auto-Uppercase Test)
```
Find interventional trials with single masking
```

**Expected:** Should handle case-insensitive enum values (if implemented), or return validation error

### 14. Empty Filter Result
```
Search for diabetes trials, then filter to children (age 0-17) with quadruple-blind masking in Phase 4
```

**Expected:** Should return "Filtered to 0 studies" gracefully (unlikely combination)

### 15. Session Chaining
```
Search for cancer trials, get session ID, then use get_trial_details on first result's NCT ID
```

**Expected Flow:**
- `search_trials`: condition="cancer"
- Note first NCT ID from results
- `get_trial_details`: nctId="NCT...", includeEligibility=true

---

## Performance & Caching Tests

### 16. Repeat Search (Cache Hit)
```
Search for diabetes trials in California twice in a row
```

**Expected:** Second search should be instant (<100ms) from memory cache

### 17. Large Refinement Set
```
Search for cancer trials (likely >100 results), then apply multiple filters sequentially
```

**Expected:** Each refinement should be <1s (SQLite indexed queries)

### 18. Raw JSON Fallback Performance
```
Search for 500+ trials, then apply Phase 2 filters (allocation, interventionModel, primaryPurpose)
```

**Expected:** Monitor filtering latency - should be <500ms for on-the-fly JSON parsing

---

## Real-World Scenarios

### 19. Competitive Landscape Analysis
```
Find all Phase 3 pembrolizumab trials sponsored by Merck, filter to recruiting trials with results, export to JSON
```

**Expected Flow:**
- `search_trials`: intervention="pembrolizumab", phase="Phase 3", sponsorSearch="Merck"
- `refine_results`: sessionId="...", sponsorClass="INDUSTRY", hasResults=true
- `export_results`: sessionId="...", format="json", outputPath="merck_pembrolizumab.json"

### 20. Rare Disease Pediatric Trial Discovery
```
Search for cystic fibrosis trials accepting children, then filter to:
- Observational or interventional studies
- Accepting healthy volunteers
- With treatment or prevention purpose
- Show top 10 with detailed summary
```

**Expected Flow:**
- `search_trials`: condition="cystic fibrosis"
- `refine_results`: sessionId="...", ageGroups=["CHILD"], healthyVolunteers=true, primaryPurpose="TREATMENT"
- `summarize_session`: sessionId="...", maxResults=10

---

## Quick Validation Commands

After implementation, run these **CLI equivalents** to verify:

```bash
# Test Phase 1
node dist/cli/index.js search --condition "diabetes" --status "Recruiting"
node dist/cli/index.js filter <session_id> --study-type "INTERVENTIONAL" --healthy-volunteers

# Test Phase 2
node dist/cli/index.js filter <session_id> --allocation "RANDOMIZED" --min-age "18 Years"

# Test Phase 3
node dist/cli/index.js filter <session_id> --masking "DOUBLE" --fda-regulated --keyword "biomarker"

# Export test
node dist/cli/index.js export <session_id> --format csv --output test.csv
```

---

## Expected Output Patterns

**Successful Filter:**
```
Filtered to 15 studies (from 143)

1. NCT12345678 - Study Title Here
   Phase: Phase 3 | Status: Recruiting
   Location: California, United States
   Enrollment: 250 participants
   ...

**Session ID:** session_1234567890_abc123
```

**No Results After Filter:**
```
Filtered to 0 studies (from 143)

No studies match the specified criteria. Try relaxing some filters.
```

**Error Handling:**
```
Error: Session session_invalid_123 not found or has no results.
```

---

## Filter Summary

### Phase 1 - Simple Filters (4 filters)
- `studyType` - Study classification
- `sex` - Eligible sex
- `healthyVolunteers` - Accepts healthy volunteers
- `sponsorClass` - Sponsor type

### Phase 2 - Moderate Filters (5 filters)
- `allocation` - Randomization type
- `interventionModel` - Study design
- `primaryPurpose` - Research intent
- `minAge` - Minimum age
- `maxAge` - Maximum age

### Phase 3 - Complex Filters (5 filters)
- `ageGroups` - Age categories (array)
- `masking` - Blinding type
- `fdaRegulated` - FDA regulation status
- `keyword` - Keyword search

**Total: 14 new filters + 11 existing filters = 25 total filter capabilities**
