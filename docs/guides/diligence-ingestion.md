# Diligence Ingestion: Data Room to Brain Pages

## Goal

Turn pitch decks, financial models, and data room materials into searchable, cross-referenced brain pages with bull/bear analysis.

## What the User Gets

Without this: pitch decks sit in email attachments. Financial models in Google
Drive. No cross-reference to the company brain page. You can't search "what
were the key metrics from Acme Corp's Series A deck?"

With this: every data room document is extracted, diarized, cross-referenced to
the company page, and searchable. Index.md gives you the bull/bear case at a
glance. `cortex query "Acme Corp revenue growth"` finds the exact chart.

## Implementation

Recognize data room materials by PDF filenames containing "Data Deck", "Intro
Deck", "Data Room", "Cap Table", "Financial Model", "Investor Memo", "Pitch
Deck", or series round names. Spreadsheet tabs with Revenue, Retention, Cohorts,
CAC, Gross Margin, Unit Economics, ARR. User language like "data room",
"diligence", "deck", "pitch", "fundraise materials".

### The 9-Step Pipeline

**Step 1: Identify the Company.**
From the document content or filename, identify the company name.
Check if `brain/companies/{slug}.md` exists.

**Step 2: Create Diligence Directory.**

```bash
mkdir -p brain/diligence/{company-slug}/.raw
```

**Step 3: Extract Content.**

- **PDFs:** Use PDF extraction tool. For scanned/image-heavy PDFs,
  use OCR (e.g., Mistral OCR or similar).
- **Spreadsheets:** Export each sheet as CSV. For Google Sheets:
  ```
  https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?tqx=out:csv&sheet={Sheet Name}
  ```

**Step 4: Diarize and Save.**
Write extracted content to `brain/diligence/{company}/{doc-name}.md`:
- Document title and type
- Section-by-section breakdown with key metrics
- Notable footnotes or caveats
- Raw data tables where relevant

**Step 5: Save Raw Files.**
Copy original PDFs/files to `brain/diligence/{company}/.raw/`
Preserve originals for reference. The diarized version is for search.

**Step 6: Create or Update index.md.**
Every diligence directory needs an `index.md`:

```markdown
# {Company Name} — Diligence

## Round Details
- Stage: Series A
- Amount: $10M
- Date: 2026-04

## Document Inventory
- [Pitch Deck](pitch-deck.md) — 25 slides, company overview + traction
- [Financial Model](financial-model.md) — 5 tabs, 3-year projections
- [Cap Table](cap-table.md) — current ownership + option pool

## Key Findings
- Revenue growing 30% MoM for last 6 months
- CAC payback period: 4 months
- Net retention: 135%

## Bull Case
- Strong product-market fit signal (NPS 72)
- Expanding into adjacent vertical

## Bear Case
- Single customer represents 40% of revenue
- Burn rate increased 3x last quarter

## Open Questions
- What's the path to profitability?
- How defensible is the moat?
```

**Step 7: Enrich Company Brain Page.**
Update `brain/companies/{slug}.md`:
- Add document sources to frontmatter
- Update compiled truth with key findings
- Add "See Also" link to diligence directory
- If no company page exists, create one via the enrich skill

**Step 8: Commit.**

```bash
cd brain/ && git add -A && git commit -m "diligence: {Company} — {doc type} ingestion" && git push
```

**Step 9: Publish (if asked).**
When the user wants a shareable brief, create a password-protected
published version. Strip internal notes and raw assessment language.

### Quality Bar

A good diligence page reads like an intelligence assessment:
- **What they say** vs **what the data shows** (the gap is the insight)
- Explicit bull/bear case (not just a summary)
- Key metrics highlighted, not buried
- Open questions that need answers before decision

## Tricky Spots

1. **PDF extraction is lossy.** Scanned decks and image-heavy PDFs lose
   tables and charts during extraction. Always check the diarized output
   against the original `.raw/` file. If key metrics are missing, re-extract
   with OCR or transcribe manually.

2. **Idempotency on re-ingestion.** If the user sends an updated deck for
   the same company, don't create a duplicate directory. Check for an existing
   `brain/diligence/{company-slug}/` and update in place. Append a version
   suffix to the document file if the old version should be preserved.

3. **index.md completeness.** The index.md is the entry point for the entire
   diligence package. If it's missing the bull/bear case or open questions,
   the diligence is incomplete. Always generate all sections even if some
   require judgment calls -- flag uncertain assessments explicitly.

## How to Verify

1. **Search for key metrics.** After ingestion, run
   `cortex search "revenue growth"` or `cortex search "{company name} CAC"`.
   The diarized content should appear in results. If it doesn't, the sync
   or embedding step was missed.

2. **Check the company page cross-reference.** Open
   `brain/companies/{slug}.md` and verify it links to the diligence directory.
   The compiled truth section should include key findings from the deck.

3. **Verify index.md has all sections.** Open
   `brain/diligence/{company}/index.md` and confirm it has Round Details,
   Document Inventory, Key Findings, Bull Case, Bear Case, and Open Questions.
   Missing sections mean the pipeline stopped early.

---

*Part of the [Cortex Agent Runtime](../CORTEX_AGENT_RUNTIME.md).*
