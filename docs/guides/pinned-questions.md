# Pinned questions

A pinned question is a question gbrain keeps answered. You pin it once; gbrain
answers it from your notes with a citation behind every sentence, checks those
citations on every read, and refreshes the answer when its evidence changes.
A sentence whose evidence was edited, deleted, forgotten, superseded or has
expired is flagged stale the moment you read it, and `context_pack` leaves it
out.

Pinned questions are private to the brain owner. Answers are paid model calls;
reads are free.

## Quick start

```bash
gbrain questions pin "Who leads acme-example engineering now?" --entity companies/acme-example
gbrain questions status default:questions/who-leads-acme-example-engineering-now-1a2b3c4d
gbrain questions refresh default:questions/who-leads-acme-example-engineering-now-1a2b3c4d
gbrain questions list
gbrain questions unpin default:questions/who-leads-acme-example-engineering-now-1a2b3c4d
```

`pin` prints the first answer (it waits up to 30 seconds; `--defer` skips it)
and the question's id. Every subcommand takes `--json`, which returns the
receipt described below. The command exits 1 when the answer is blocked.

The same operations exist over MCP: `questions_pin`, `questions_list`,
`questions_status`, `questions_refresh` and `questions_unpin`. They are on the
full tool surface (not the starter surface).

| Tool | Scope | What it does |
|---|---|---|
| `questions_pin` | write | Pins `question` (or re-pins / activates `id`); returns the first answer or `awaiting_refresh` with the next step |
| `questions_list` | read | Every pin with freshness and blocked reason, plus fresh / stale / pending counts |
| `questions_status` | read | One pin: answer sentences with stale flags, watermark, last refresh, next action |
| `questions_refresh` | write | Refreshes now (`full: true` recomputes) |
| `questions_unpin` | write | Stops refreshes and archives the page |

## Ids and scope

An id is source-qualified: `<source>:questions/<slug>`. The slug comes from
the question and its scope, so pinning the same question with the same scope
again returns the existing pin (`created: false`) and spends nothing.

The scope says where evidence comes from. Over MCP it is an object:

```json
{ "question": "Where does acme-example build widgets?", "scope": { "source": "default", "entity": "companies/acme-example" } }
```

| Field | CLI flag | Meaning |
|---|---|---|
| `source` | `--source <id>` | The source the pin lives in and reads evidence from; default: the current source |
| `slug_prefix` | `--prefix <p>` | Only pages under this prefix, for example `projects/` |
| `entity` | `--entity <slug>` | The entity page the question is about; `context_pack` for that entity carries the answer |

The same question in two sources is two pins with two ids.

## What a receipt says

Every pin, list, status and refresh returns the same fields:

| Field | Meaning |
|---|---|
| `freshness` | `fresh`, `stale` (at least one sentence's evidence changed), `awaiting_refresh` (no answer yet), `refreshing` (a refresh holds the lease), `archived` |
| `answer` | Sentences with `stale` and `reasons`, and `origin` (`model` or `owner`) |
| `evidence_watermark` | The page-generation clock and newest fact id the answer was built from |
| `new_evidence_since_watermark` | Pages or facts in scope changed after the answer; the next cycle refreshes it |
| `last_refresh_at` | The last successful refresh |
| `blocked_reason` | Why the answer cannot be refreshed right now (below), or null |
| `fix` | The step that fixes it: `argv`, `mcp`, `consent`, `actor`, `why` and a read-only `verify` |
| `verify` | `gbrain questions status <id> --json` / `questions_status {id}` |

| `blocked_reason` | Meaning | Next action |
|---|---|---|
| `awaiting_consent` | The pin was made over MCP (or imported from a disabled `dream.auto_think`) and is not active | The owner runs `gbrain questions pin --id <id>` |
| `no_model_key` | No chat-model key is configured | The user adds an Anthropic or OpenAI key (`gbrain providers list` shows how) |
| `budget_exhausted` | This run's refresh budget is spent | Raise `cycle.standing_questions.budget_usd`, or wait for the next run |
| `refresh_failed` | The last refresh failed; the previous answer is kept with its stale flags | `questions_refresh {id, full: true}` |
| `no_worker` | Nothing runs scheduled refreshes (no `standing_questions` phase in two days, no autopilot) | `questions_refresh {id}`; recurring refreshes need autopilot, which a pin never installs |

A stale or blocked answer also adds a `pinned_answer_stale` notice to the
response.

## Freshness

Staleness is computed when you read, not when something writes. Each answer
sentence records what it cites: a page revision, a fact, a timeline entry or
a take. On every read gbrain checks those against the current brain. A
sentence is stale when its evidence:

- was edited, renamed away or made private (the page's revision changed);
- was soft-deleted or hard-deleted, or its source was archived;
- was forgotten, superseded, or expired because its `valid_until` passed;
- is a take that was deactivated or changed, or a timeline entry that was removed;
- can't be found or verified (a sentence with no citation is always stale).

`context_pack` returns only the fresh sentences of pinned answers for the
entities you asked about, in an optional `pinned_questions` field, and counts
the left-out sentences in an optional `withheld` field (with the refresh
command). Both fields are outside `text` and the token budget:
`pinned_questions[]` is `{ id, question, answer[], freshness }` and `withheld`
is `{ stale_sentences, question_ids[], refresh_command }`. Owner-capable
callers get them: the local CLI, or a connection that reads private pages and
is not slug-fenced. Every other caller gets neither.

Refreshing re-retrieves evidence from the current brain and edits the
previous answer. After a deletion, a withdrawal, a conflicting correction, or
for a question about the latest or current state, it recomputes the answer
from scratch. A refresh publishes only if nothing it cited changed while it
ran; otherwise the previous answer stays, still flagged, and the next refresh
tries again. A model reply with no parseable answer is retried once with a
JSON-only reminder (both calls count toward spend); if that also fails, the
refresh fails with `refresh_failed:model_output_not_json`. A failed refresh
never removes the previous answer.

Question pages, synthesis pages and pages that copy a published answer are
never used as evidence.

## Your own notes

Each pin has a page, `questions/<slug>`, holding the question. Write your own
claims on it, below the heading. Every sentence you write there is part of the
answer as your claim (`origin: owner`). When you edit the page, your claims
read stale until the next refresh picks up the new text. The generated answer
is never stored in the page or its file; read it with `gbrain questions
status`.

## Who can see pinned questions

Pinned questions are owner-private:

- The question page is private, and it never appears in search, query,
  recall or think results, for anyone.
- Answers are never written to pages, chunks, page history, exports or git.
- The `questions_*` tools and the `context_pack` fields answer only the local
  CLI and MCP connections that can read private pages (the operator set
  `search.remote_private_pages=visible`) and are not slug-fenced. Any other
  connection gets `question_owner_only` with the command the owner runs
  instead, and `context_pack` shows it nothing.

## Paid refresh and consent

A pin made on the CLI is active: it answers now and refreshes when its
evidence changes. A pin made over MCP is created inactive and spends nothing
until the owner activates it with `gbrain questions pin --id <id>`, unless the
owner has set a paid preapproval (`gbrain config set
consent.preapprove.paid.max_usd_per_run <usd>`), which also caps each MCP
refresh. Pinning never installs a scheduler.

Scheduled refreshes run in the `standing_questions` cycle phase (part of
`gbrain dream` and autopilot). Settings:

| Key | Default | Meaning |
|---|---|---|
| `cycle.standing_questions.budget_usd` | `1.00` | Spend cap per run (`0` spends nothing) |
| `cycle.standing_questions.max_per_cycle` | `5` | Refreshes per run |
| `cycle.standing_questions.cooldown_days` | `1` | Minimum days between scheduled refreshes of one pin |
| `cycle.standing_questions.allow_unpriced` | `false` | Let a model with no known price run uncapped |
| `cycle.standing_questions.enabled` | `true` | `false` stops the phase |
| `models.standing_questions` | deep tier | The answer model |

A draft-only pin (`publish_mode: draft`) is refreshed but not served by
`context_pack`; `gbrain questions pin --id <id> --publish` publishes it.

## Coming from dream.auto_think

The `dream.auto_think` settings became pins when this brain upgraded. Each
saved question is a pin in the `default` source:

| Old key | Now |
|---|---|
| `dream.auto_think.questions` | One pin per question (`origin: auto_think`) |
| `dream.auto_think.enabled=false` | The pins are inactive until you run `gbrain questions pin --id <id>` |
| `dream.auto_think.budget` | `cycle.standing_questions.budget_usd`; a zero budget leaves the pins inactive |
| `dream.auto_think.auto_commit=false` | The pins are draft-only |
| `dream.auto_think.cooldown_days` | Each pin's cooldown |
| `dream.auto_think.max_per_cycle` | `cycle.standing_questions.max_per_cycle` |
| `models.auto_think` / `dream.auto_think.model` | Each pin's model |

The upgrade made no model call. `gbrain config get` or `set` on an old key
prints its replacement, and `gbrain dream --phase auto_think` points to
`gbrain questions list`.
