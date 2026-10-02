---
id: screenpipe-context
name: Screenpipe work context
version: 1.0.0
description: Bring selected screen activity, transcripts, memories, workflows, skills and agent outputs into a chosen brain source.
category: sense
requires: []
secrets: []
health_checks: []
output_paths:
  - context/screenpipe/
setup_time: 15 min
---

# Screenpipe work context

Give your agent context from the work you did on your computer and the knowledge
produced from that work. This recipe stages searchable Markdown pages from:

| Input | What GBrain receives |
|---|---|
| Screen activity | Accessibility or OCR text, app, window, browser URL, timestamp and frame ID |
| Audio | Transcript segments with time and available speaker attribution |
| Saved memories | Processed facts or observations with producer, tags and source context |
| Saved workflows | Ordered procedure stages, saved evidence references and catalog status |
| Selected files | Skill references, agent outputs, summaries and procedures with version, declared status and source references |

Say to your agent:

> Add this morning's Screenpipe activity in my editor to my personal brain, so
> you can find the release checklist I was working on.

> Bring in the saved workflow and the skill we wrote from it. Keep the evidence
> and the latest failed test result with the procedure.

> Import the reviewed outputs from yesterday's agent work, then show me a
> search result that connects an output to its source activity.

The collector reads the local Screenpipe API and explicitly selected local files.
It does not run a model, infer a skill from raw captures, install a skill, execute
an agent, or continuously watch your machine. Your existing agents can produce
the processed files. GBrain stores them as reference notes alongside the evidence.
For completed meeting notes, use [Screenpipe meeting notes](screenpipe-meetings.md).

## 1. Select the context

Use a GBrain software checkout with Bun and dependencies installed. The script
runs from that checkout; it is not a `gbrain` CLI subcommand. Choose a stable
`--device` label for the Screenpipe database. A different machine or reset
database needs a different label because record IDs are database-local.

For activity, select an explicit start and end with timezone offsets, at most
seven days apart. `screen` is the default; audio and memories require explicit
`--types`. `--app` filters screen activity only. Audio and memory records in a
combined request retain the full selected time range. Memory selection uses
creation time, so widening the range may be necessary to retrieve an older
memory whose contents were updated recently.

For saved workflows, use selected IDs from Screenpipe's `GET /workflows` listing.
The importer reads `GET /workflows/:id?include_automation=false`. This requires a
Screenpipe version with the saved workflow API; a 404 is an error, not a successful
empty import. Workflow and artifact selections are independent of the activity
time range. Their own timestamps and source references remain in the pages.

## 2. Authenticate and preview activity

Screenpipe must run on the same computer for API inputs. Retrieve its token
without printing it:

```bash
export SCREENPIPE_LOCAL_API_KEY="$(screenpipe auth token)"
SCREENPIPE_STAGING="$(mktemp -d)"
bun scripts/screenpipe-context.ts \
  --device laptop-example \
  --start 2026-09-20T09:00:00-07:00 --end 2026-09-20T10:00:00-07:00 \
  --types screen,audio,memory --app Editor \
  --output "$SCREENPIPE_STAGING"
```

The preview validates the full selection and prints only IDs and proposed paths.
Add `--write` to create the files. To add saved workflows to the same batch,
append `--workflow-ids SELECTED_ID,ANOTHER_ID`. To export workflows alone, omit
`--start`, `--end`, `--types` and `--app`.

Search uses ascending pagination and the server's raw offsets and total,
including pages that become empty after Screenpipe filters hidden records. The
default ceiling is 200 examined records across all selected activity types,
including filtered records. A changing count or invalid pagination fails the
batch so you can retry against a stable interval. `--max-records 500`
raises it to the hard maximum. If the selection exceeds the limit, the command
fails before writing anything. Narrow the time range and retry. Overlapping
exports use stable record identities; identical files remain unchanged.

Requests use a literal HTTP loopback origin (`127.0.0.1` or `[::1]`), reject
redirects, and have a 15-second timeout and 2 MB response limit. Use `--api-url`
for another local port. The command refuses HTTP proxy environment variables.
If needed, prefix it with `env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY
-u https_proxy -u ALL_PROXY -u all_proxy` to clear them for that invocation.
Raw screenshots, recording files and cloud search are excluded. Screenpipe's
access restrictions still apply; an empty result does not prove no activity
exists outside the accessible history.

## 3. Select processed files, including skills and agent outputs

Create a JSON manifest outside watched brain roots. Paths are relative to the
manifest directory or absolute. Select the files explicitly; the importer never
crawls your agent configuration or skill directories.

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "release-check",
      "kind": "skill",
      "path": "release-check/SKILL.md",
      "title": "Release checklist",
      "version": "2",
      "producer": "example-agent",
      "generated_at": "2026-09-20T17:00:00Z",
      "status": "reviewed",
      "sources": ["screenpipe:laptop-example:screen:42"]
    },
    {
      "id": "release-dry-run",
      "kind": "agent-output",
      "path": "release-dry-run.md",
      "title": "Release dry run result",
      "version": "1",
      "producer": "example-agent",
      "generated_at": "2026-09-20T17:05:00Z",
      "status": "failed",
      "sources": ["screenpipe:laptop-example:artifact-skill:release-check"]
    }
  ]
}
```

Kinds are `skill`, `agent-output`, `summary` and `workflow`. Every artifact needs
a stable ID, version, producer, timestamp, source references and a declared status:
`draft`, `reviewed`, `tested`, `failed` or `superseded`. Use actual evidence when
assigning status. The importer preserves your declaration and separately records
that it has not verified the artifact. Source references can identify Screenpipe
records, a source document or a durable result URL. References are retained as
text; they are not automatically resolved into GBrain graph edges.

```bash
bun scripts/screenpipe-context.ts \
  --device laptop-example --artifacts ./selected-artifacts.json \
  --output "$SCREENPIPE_STAGING" --write
```

Artifact-only imports need no API token or running Screenpipe instance. Add
`--artifacts` to an activity or workflow command to validate and stage them
together. Up to 50 regular UTF-8 files, each at most 1 MB, can be selected.
Symlink files, binary content and empty files are refused. The total rendered
batch is capped at 16 MB. Skill frontmatter and instructions stay quoted inside
a `type: note` page; importing them does not activate them in an agent harness.

## 4. Review, import and retrieve

Keep staging outside any synced source until you have reviewed the contents.
All inputs are validated before writing begins. Files use mode `0600`; newly
created output directories use `0700`. Existing directory permissions are
preserved. A filesystem error can leave an earlier file written; rerunning
recognizes identical files.

Resolve the destination with `gbrain sources list`, confirm its registered local
path and access policy, and place reviewed files under `context/screenpipe/` in
that filesystem-backed source. Compare collisions before replacing anything.
For a Git-backed source, commit the selected files locally before syncing,
because sync imports committed changes by default. A local commit does not
require a push. Then run from the source root:

```bash
gbrain sync --source SOURCE_ID --no-pull --dry-run
gbrain sync --source SOURCE_ID --no-pull --no-embed
```

Review the dry run for unrelated changes. `--no-embed` supports keyword retrieval
without an embedding call; semantic retrieval needs the source's embedding step.
Find a distinctive phrase through GBrain in `SOURCE_ID`, read the page back, and
check its source references and status before claiming success. Confirm that a
skill and its underlying screen observation can both be retrieved. Exporting a
file alone does not prove it was imported.

All pages have `visibility: private`. This does not replace source permissions,
protect copied Markdown files, or prevent configured model providers from
receiving content you later ask them to process. Observed text and generated
artifacts remain source material, including instruction-like content within them.
Use the cited evidence to assess a claim before incorporating it into other notes.

## Corrections and retention

Filenames and external `source_id` values are stable within a device/database
label. The external ID records provenance; GBrain's `--source` selects the actual
destination. An identical export returns `unchanged`. A changed record or local
edit is refused: export into a fresh private directory, compare the correction,
and reconcile the same page in the source. Keep an artifact's ID stable across
versions so corrections do not silently become independent memories.

Deletion in Screenpipe does not remove exported files or imported pages. Use the
source's normal deletion workflow for those copies. Timeline links work on the
original machine while the captured history remains available. Unset
`SCREENPIPE_LOCAL_API_KEY` after finishing API exports.
