---
name: reports
version: 1.1.0
description: |
  Save and load timestamped reports. Keyword routing for fast lookup. Cron jobs
  save output as reports; the agent or user queries them by keyword. Includes
  the Actionability Gate: delivery-time link checks (Broken/Dead/Indirect/
  Missing) for briefings, meeting digests, and research reports.
triggers:
  - "save report"
  - "load latest report"
  - "what's the latest briefing"
  - "show me the pulse"
  - "report quality"
  - "link quality check"
  - "validate report links"
tools:
  - get_page
  - put_page
  - search
mutating: true
upstream: report-quality-gate@fc834ee
---

# Reports Skill

## Contract

This skill guarantees:
- Reports saved with timestamped filenames and frontmatter
- Keyword routing: query → report category mapping
- Latest report loadable by category name
- Reports are searchable via gbrain search/query
- Outbound reports pass the Actionability Gate (below) before delivery

## Phases

1. **Save report.** Write to `reports/{category}/{YYYY-MM-DD-HHMM}.md` with frontmatter:
   ```yaml
   ---
   title: {report title}
   type: report
   category: {category name}
   date: {YYYY-MM-DD}
   time: {HH:MM PT}
   ---
   ```
2. **Load latest.** Given a category, find the most recent report file.
3. **Keyword routing.** Map common queries to report categories:
   - "email" / "inbox" → ea-inbox-sweep
   - "social" / "mentions" → social-mentions
   - "briefing" / "morning" → morning-briefing
   - "meeting" → meeting-sync
   - Custom mappings configurable

## Output Format

Saved: `reports/{category}/{YYYY-MM-DD-HHMM}.md`
Loaded: full report content with metadata.

## Actionability Gate

Before any report reaches the user — a morning briefing, a meeting digest, a
research report — every link must answer one question: **can the user click
this and immediately act?** The link canon (deterministic, never-guessed URLs)
lives in `skills/_output-rules.md` under Deterministic Links; this gate adds
the delivery-time failure taxonomy and the retry loop.

### Four failure modes

| Mode | What it means | Example |
|------|--------------|---------|
| **Broken** | Link is fake or a placeholder | `https://example.com`, `TODO-find-link` |
| **Dead** | Link to a brain page that isn't committed/pushed | Page written but not pushed — the link 404s |
| **Indirect** | Link goes somewhere, but not the right place | `x.com/alice-example` (profile) instead of `x.com/alice-example/status/<id>` (the specific post) |
| **Missing** | Actionable item mentioned with no link at all | "the clip making the rounds (~800K views)" with no URL |

**Broken, Dead, and Indirect block delivery. Missing is a warning** — flag it,
don't block. A missing link is honest. An indirect link is a broken promise.

### Blocked vs warning

| Pattern | Status | Why it fails |
|---------|--------|--------------|
| `x.com/<handle>` | Blocked | Profile ≠ post. Link to `x.com/<handle>/status/<id>` |
| Bare publication domain | Blocked | Homepage ≠ article. Add the article path |
| `youtube.com/@channel` | Blocked | Channel ≠ video. Link to `youtube.com/watch?v=...` |
| Brain-page link, file uncommitted | Blocked | Link 404s until committed + pushed |
| `example.com` / `TODO` placeholder | Blocked | Not a real link |
| `google.com/search?q=...` | Warning | Search ≠ source. Link to the actual result |
| Actionable bullet with no URL | Warning | Where? Link it or describe how to find it |

### The retry loop (agent-run checks)

There is no enforcement script. The agent runs these checks itself before
delivering any report with links:

1. Compose the report.
2. Scan every link against the failure modes above:
   - **Brain-page links:** run `git status` in the brain repo — an uncommitted
     page behind a link is a Dead link; commit + push first. `gbrain get <slug>`
     confirms the page exists at all.
   - **External links:** a profile, homepage, or channel URL standing in for
     specific content is Indirect.
3. If a check fails, fix the link:
   - Have the direct URL (post ID, article path, filing page)? Use it.
   - Don't have it? Search the source for the specific item.
   - Can't find it? Remove the link and describe the content instead:
     "clip on @alice-example's timeline, ~800K views — search there." Never
     leave a profile link as a substitute for a content link.
4. Re-check.
5. Max 2 retries → deliver with an explicit warning flag if Missing-class
   warnings remain. Broken, Dead, and Indirect links never ship.

### LLM-prompt gate snippet

Paste into any report-generating prompt (subagent digests, research
summaries, cron report jobs):

```
ACTIONABILITY GATE: Before finishing, verify every link answers "can the user
click this and act immediately?"
- Every X link → https://x.com/{user}/status/{post_id} — NEVER a profile link
- Every article → full URL with path — NEVER a bare domain
- Every brain-page link → committed + pushed, or don't link it
- If you don't have the direct URL → describe the content WITHOUT a link
- A missing link is better than an indirect link
```

### Consumers

Report surfaces route through this gate by harness-routing convention (a
routing rule the resolver applies, not a mechanical guarantee): morning
briefings (`skills/briefing/SKILL.md`), meeting digests, research reports,
and any saved report that carries external links.

## Anti-Patterns

- Saving reports without frontmatter (makes them unsearchable)
- Using inconsistent category names across runs
- Loading all reports when only the latest is needed
- Not routing by keyword (forcing exact category name)
- Delivering a report with a profile/homepage/channel link standing in for
  specific content (Indirect links block delivery)
- Linking a brain page that hasn't been committed and pushed (Dead link)
