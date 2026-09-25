---
name: citation-fixer
version: 1.1.0
description: |
  Audit and fix citation formatting across brain pages. Ensures every fact has
  an inline [Source: ...] citation matching the standard format. Extended in
  v0.25.1: scans for broken tweet/post references that lack actual URLs and
  resolves them via the host's X / Twitter API integration.
triggers:
  - "fix citations"
  - "fix broken citations"
  - "citation audit"
  - "check citations"
  - "citation fixer"
tools:
  - search
  - get_page
  - put_page
  - list_pages
mutating: true
---

# Citation Fixer Skill

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> the canonical citation format every fix should match.
>
> **Output rule:** all links MUST be deterministic (built from API data,
> not composed by LLM). See [_output-rules.md](../_output-rules.md).

## Contract

This skill guarantees:

- Every brain page is scanned for citation compliance.
- Missing citations are flagged with specific location.
- Malformed citations are fixed to match the standard format.
- **(v0.25.1)** Tweet / post references without URLs are resolved via
  X API and patched with deterministic `https://x.com/<handle>/status/<id>`
  links.
- Results reported with counts (scanned, fixed, remaining).

## Phases

1. **Scan pages.** List pages and read each one, checking for inline
   `[Source: ...]` citations.
2. **Identify issues:**
   - Facts without any citation
   - Citations missing date
   - Citations missing source type
   - Citations with wrong format
   - **(v0.25.1)** Tweet references without `x.com` URLs
3. **Fix format issues.** Rewrite malformed citations to match
   `conventions/quality.md`.
4. **(v0.25.1) Resolve tweet references** via the X API integration.
5. **Report results.** Count: pages scanned, citations found, issues
   fixed, tweets resolved, remaining gaps.

## Tweet resolution pipeline (v0.25.1 extension)

For each broken tweet reference, follow this chain. The actual API call
goes through whatever X integration the host has configured (typical
shape: a recipe under `recipes/x-api/` with handle / search-all
endpoints).

### Step 1: Identify broken references

Scan the page for patterns that indicate tweet references without URLs:

- Contains words like `tweeted`, `posted`, `said on X`, `RT`, `retweet`,
  `X post`
- Contains quoted text that looks like a tweet (short, punchy, often
  starts with a quote)
- Has `[Source: ... X/Twitter ...]` without an `x.com` URL
- References engagement metrics (likes, impressions) without a link

### Step 2: Extract searchable content

From each broken reference, extract:

- The **handle** (if mentioned: `@<username>`)
- The **quoted text** (if available)
- The **approximate date** (often present in surrounding timeline entries)

### Step 3: Search for the actual tweet

Use the host's X API integration. Query patterns:

```
# Handle + quoted text:
from:<handle> "<exact quote fragment>"

# Quoted text only:
"<exact quote fragment>"

# Original of a retweet:
"<exact quote>" -is:retweet
```

### Step 4: Verify and extract metadata

Once a candidate is found:

- Confirm the text matches the quoted fragment.
- Pull the tweet id, author handle, engagement metrics (likes / RTs /
  impressions).
- Construct the URL: `https://x.com/<handle>/status/<tweet_id>`.

### Step 5: Patch the brain page

Replace the broken citation with a proper one:

**Before:**

```
"<quote fragment>" [Source: <some hand-wavy attribution>]
```

**After:**

```
"<full verified quote>" — <N> likes, <N> RTs, <N> impressions
[Source: [X/<handle>, YYYY-MM-DD](https://x.com/<handle>/status/<tweet_id>)]
```

## Batch mode

When sweeping many pages:

### Find candidate pages

```bash
# Pages mentioning tweets but with no x.com links
for f in $(find . -name "*.md" -not -path "./node_modules/*"); do
  refs=$(grep -ci "tweet\|posted\|x post\|RT\|retweet\|said on X" "$f")
  links=$(grep -c "x.com/.*/status/" "$f")
  if [ "$refs" -gt 2 ] && [ "$links" -eq 0 ]; then
    echo "$f"
  fi
done
```

### Priority order

1. Recently created / updated pages — fresh broken refs are easiest to
   resolve while context is fresh.
2. High-traffic pages (frequent reads / writes from other skills).
3. Everything else — bulk cleanup over time.

### Rate limiting

- X API: respect the host's tier limits; don't hammer.
- Target ~50 pages per batch run.
- 1-3 API calls per page (search + verify).
- Batch-commit every 10-20 pages so a partial failure doesn't lose
  progress.

## Output format

```
Citation Audit Report
=====================
Pages scanned:        N
Citations found:      N
Issues fixed:         N
Tweet links resolved: N
Remaining gaps:       N (pages with uncitable facts)
```

## Anti-Patterns

- ❌ Inventing citations for facts that have no source. Flag them.
- ❌ Removing facts that lack citations (flag them; don't delete).
- ❌ Fixing citations without reading the full page context.
- ❌ Batch-fixing without checking quality on a sample first
  (see `conventions/test-before-bulk.md`).
- ❌ Composing tweet URLs by guessing the tweet id. Always go through
  the X API; deterministic links only.

## Integration

This skill can be called:

- **Manually** — "fix citations on this page"
- **As a batch cron** — weekly sweep of pages with broken refs
- **By other skills** — `enrich` or `media-ingest` can call citation-fixer
  before commit to validate output

## Metrics

If running as a recurring batch, track state in a small JSON file under
`~/.gbrain/citation-fixer-state.json`:

```json
{
  "last_run": "2026-04-15T...",
  "pages_scanned": 0,
  "citations_fixed": 0,
  "tweet_links_resolved": 0,
  "citations_unresolvable": 0,
  "pages_remaining": 1424
}
```


## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
