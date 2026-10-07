# Link facts saved without an entity

A fact is only useful to entity lookups when it is pinned to the person,
company or project it is about. Facts saved without that pin (an agent called
`remember` without `entity`, or a page import whose extractor named nobody)
are invisible to entity recall, never show on the entity's page, and the
System One conflict sweep skips them as `no_entity`.

GBrain now prevents most of them at write time and repairs the backlog with
`gbrain facts relink`.

**Say to your agent:** *"Link my unattributed facts to the people and companies they're about."*
The agent runs `gbrain facts relink --dry-run`, shows you the plan, then runs it.

**Say to your agent:** *"Why is the conflict sweep finding nothing?"*
The agent runs `gbrain decide status` and `gbrain doctor`; an `unlinked_facts`
warning or a `no_entity` share points at `gbrain facts relink`.

## What happens at write time

When `remember` gets no `entity`, it looks for one in the fact text without
calling a model. It links only when the text names exactly one existing
entity page by its full name, slug or alias, and no other name competes. "Acme
Example raised a seed round" links to `companies/acme-example`. "Alice Example
introduced me to Charlie Example", "Bob said yes" (a bare first name) and
"Northstar Example copied Acme Example's pricing" (a second company with no
page) stay unattributed. The response says what happened: `entity_inferred:
"mention"` when it linked, or `warnings: ["NO_ENTITY"]` with a hint when it did
not. Pass `infer_entity: false` to skip inference for one call.

Page imports work the same way, and a fact extracted from an entity page with
no other name in it belongs to that page.

Turn write-time inference off with `gbrain config set facts.entity_inference
off`. That does not undo earlier links, and it does not affect `gbrain facts
relink`.

## Repair the backlog

Run these on the brain host (thin clients refuse the command).

```bash
gbrain facts relink --dry-run              # what would link; writes nothing, calls no model
gbrain facts relink                        # free tiers, then the model tier (default cap $1.00)
gbrain facts relink --no-llm               # free tiers only
gbrain facts relink --max-usd 5            # raise the model-tier cap (or: off)
gbrain facts relink --json                 # machine-readable report (schema_version 1)
```

Relink finds a subject in three tiers, cheapest first: the page a fact was
extracted from, a unique entity named in the text, and finally the configured
fact-extraction model (`facts.extraction_model`) for whatever is left. The
model's answer must quote the fact and name an existing entity page, so an
invented or injected name never links. Private facts stay out of the model
tier unless you pass `--include-private`. Before the first model call relink
prints the provider and an estimated cost.

Each linked fact keeps its id, embedding and provenance and is written onto
the entity page's `## Facts` fence exactly as a fresh `remember` with that
entity would write it (the canonical file too, when the source writes
through). Its context cell records how it was linked (`entity relinked from
mention`, `... from page`, `... by model (<model>)`). An exact duplicate of a
fact the entity already has is retired: expired, kept in history, never
deleted. Relink never creates pages and never supersedes a fact.

### Large brains: continue where you stopped

Each run examines `--limit` facts (default 1000), walking by fact id. When more
remain, the report ends with the exact command to continue:

```bash
gbrain facts relink --after-id 48211
```

Facts that can never link do not block the ones after them. `--since
2026-09-01` limits a run to recent facts.

### The conflict sweep

When the System One conflict slot is on, every linked fact is queued for the
next sweep (`queued_for_conflict` in the report). A large backlog drains over
several sweeps within the sweep's normal per-run quota and daily budget;
`gbrain decide status` shows the progress. `--no-conflict-queue` skips the
handoff.

### Reruns and cost

The model's verdicts (`no_subject`, `ambiguous`, `unverified_match`) are
remembered, so a rerun does not pay for the same fact again. Pass
`--retry-model` to ask again. The free tiers always rerun, so creating an
entity page and rerunning links facts that name it.

### Fix a wrong link

`--json` lists the facts each run linked. To move one, forget it and remember
it again with the right entity:

```bash
gbrain forget <fact-id>
gbrain remember "<the fact>" --provenance "<source>" --entity <slug>
```

## Why a fact was not linked

| Reason | Remembered | What to do |
|---|---|---|
| `no_subject` | yes | The model found no single person, company or project in the fact. Nothing to fix; rerun with --retry-model to ask again. |
| `ambiguous` | yes | The fact names more than one entity, or a name competes with the match. Link it by hand: forget it and remember it again with --entity. |
| `unverified_match` | yes | The only match is a bare first name or a name that is not in the fact. Add an alias to the right entity page, then rerun. |
| `no_mention` | no | The fact names no entity. Rerun with the model tier (drop --no-llm), or link it by hand with remember --entity. |
| `no_page` | no | The fact names an entity that has no page. Create the entity page, then rerun. |
| `model_unavailable` | no | The extraction model could not be reached. Configure it with gbrain config set facts.extraction_model <provider:model>. To skip the model tier, run gbrain facts relink --no-llm. |
| `model_unparseable` | no | The model returned output relink could not read. Rerun; if it persists, set a different facts.extraction_model. |
| `withdrawn` | no | This claim was explicitly forgotten for that entity, so relink will not attach it there. |
| `page_file_missing` | no | The entity page exists in the database but its file is missing from the source tree. Restore the file or run gbrain sync, then rerun. |
| `unfenceable` | no | The source writes through to files but has no canonical owner. Bind the source (gbrain sources writer status <source> --json, then gbrain sources writer claim <source> --path <checkout> --admin-intent writer_claim --expected-state <admin_state>), then rerun. |
| `fence_malformed` | no | The entity page has a ## Facts fence that cannot be normalized. Preview the fence repair of that page (`repair fences --slug <entity-slug>` on the brain host; read-only, and it names the exact edit for anything it will not repair), apply it, then rerun. |
| `claim_unfenceable` | no | The claim text cannot be written to a fence row unchanged (for example it is wrapped in ~~). Forget it and remember a cleaned-up claim with --entity. |
| `visibility_conflict` | no | The entity already has the same claim from the same source with the other visibility, and a page indexes only one. Forget the copy you do not want, then rerun. |
| `fence_owned` | no | The fact lives in another page fence (a transcript). Relink does not move fence-owned facts. |
| `budget_exhausted` | no | The model tier reached --max-usd. Raise --max-usd (or pass off) and rerun with the printed continuation command. |
| `revision_conflict` | no | The fact or the entity page changed while relink ran. Rerun. |

## Doctor

`gbrain doctor` reports `unlinked_facts`: the share of active facts with no
entity, the share among facts created in the last 7 days, the facts the model
already judged subjectless, and how many links write-time inference and relink
made. It warns when more than a quarter of the last week's facts are unlinked.
