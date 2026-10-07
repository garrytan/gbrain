# Retrieval feedback: teach the brain which evidence helped

GBrain learns from use. Every answer from `query`, `search`, `think`,
`synthesize` and `recall` (when it searched pages) records which pages it used
and the revision of each page it read. When your agent rates an answer, the
weights of those pages move a little, and later searches rank them up or down.
It costs no LLM calls: a rating is a small database update.

Retrieval feedback is **off by default**. Turn it on with
`gbrain config set feedback.enabled true`; ratings are then explicit only, and
`gbrain config set feedback.implicit true` also learns from `think` citations.
Held-out tests with consistent ratings showed a gain on entity-centric brains
(people, companies, deals: +2.0 NDCG@10, CI [+1.0, +3.3]) and no gain on
chat-history brains (−0.1, CI [−1.0, +0.6]); results:
[`docs/eval/decisions/p3-retrieval-feedback/VERDICTS.md`](../eval/decisions/p3-retrieval-feedback/VERDICTS.md).

**Say to your agent:** *"Turn on retrieval feedback for this brain."*
**Say to your agent:** *"That last answer used the wrong page; rate it down."*
**Say to your agent:** *"The second page was the one that helped. Tell the brain."*
**Say to your agent:** *"Show me which pages the brain has learned to distrust."*

## How it works

- An answer carries an `answer_id` (`ans_…`) and `feedback: { rateable: true }`
  in its response meta. On the CLI, `query`, `search` and `think` print
  `answer: ans_… (rate with: gbrain rate ans_… 1-5)` on stderr, and `--json`
  rows carry `answer_id`. Over MCP, `search` and `query` also put the id in
  the tool result text the model sees (hosts often hide `_meta`): `Rate after
  use: rate_answer { answer_id: "ans_…", rating: 1-5 }` on every rateable
  answer, worded as a fuller prompt on the answers where the `how_to_rate`
  cadence fires (`feedback.rating_prompt`; the cadence counter is
  per process and starts over when the server restarts). The line stays
  within 160 characters.
- A rating of 1-5 maps to a target `r = (rating - 1) / 4`. Each rated page's
  weight `w` (0.5 when never rated) moves by `w + 0.1 * (r - w)`, clipped to
  [0, 1]. Edges on the relational path into a rated page move the same way.
- Ranking multiplies each result's ordering score by `1 + λ * 2 * (w - 0.5)`,
  so the effect stays within `[1 - λ, 1 + λ]` (`feedback.influence`, λ). The
  multiplier applies to the reranker's score when the reranker ran, otherwise to
  the fused score. A brain with no ratings ranks exactly as before.
- When `think` or `synthesize` produces a real answer for the brain owner
  (CLI or stdio MCP), each cited page counts as a rating of 4 at half the
  learning rate (`feedback.implicit`, off by default). Uncited pages are left alone.
- A rating applies only to the revision the answer read. If the page changed
  since, that page is skipped (`stale_revision`): a corrected page is never
  penalized for its old text. A page edited after it was rated reads at half
  its learned deviation from neutral until it is rated again.
- Only callers that may change this brain's shared ranking record answers: the
  owner's CLI and stdio MCP, and remote clients with an unrestricted write
  grant on that source. Read-only, slug-fenced or delegated callers see no
  `answer_id`.
- No query text is stored. Answers are kept for `feedback.event_retention_days`
  (30); learned weights persist in the database (database backups include them;
  markdown export does not).

## Rating

Whole answer:

```bash
gbrain query "who leads the acme-example renewal" --json
# stderr: answer: ans_01J9Z8Q6W5K3M7T2R4V8X0Y1ZC (rate with: gbrain rate ans_01J9Z8Q6W5K3M7T2R4V8X0Y1ZC 1-5)
gbrain rate ans_01J9Z8Q6W5K3M7T2R4V8X0Y1ZC 2
gbrain search "who leads the acme-example renewal" --explain   # shows "+ feedback ×0.99"
```

Single pages, over MCP:

```json
{ "answer_id": "ans_01J9Z8Q6W5K3M7T2R4V8X0Y1ZC",
  "pages": [ { "ref": "default:notes/old-renewal-plan", "rating": 1 },
             { "ref": "default:people/alice-example", "rating": 5 } ] }
```

A whole-answer rating applies to the cited pages of a `think`/`synthesize`
answer (all gathered pages if nothing was cited) and to every returned page of
a search-shaped answer. Targeted ratings touch only the named pages. Each page
can be rated once per answer; an identical retry returns the same receipt.
The receipt lists each weight before and after, the ranking multiplier, and
anything skipped with its reason. A rating never edits stored facts or repairs
an answer: fix the page itself when it is wrong.

## Inspecting and resetting

```bash
gbrain feedback status                 # counts, weight spread, lowest-weighted pages with a next step
gbrain feedback reset --page notes/old-renewal-plan
gbrain feedback reset --source default
gbrain config set feedback.enabled true    # on (default off): recording, ratings and the ranking effect
gbrain config set feedback.enabled false   # off: no recording, no ratings, no ranking effect
gbrain config set feedback.learn false     # keep learned weights, stop learning
```

| Key | Default | Meaning |
|---|---|---|
| `feedback.enabled` | false | Recording, ratings, `answer_id` and the ranking effect. |
| `feedback.learn` | true | Write new learning. Off keeps applying learned weights. |
| `feedback.influence` | 0.1 | λ: the ranking multiplier stays within `[1 - λ, 1 + λ]` (max 0.5). |
| `feedback.implicit` | false | Learn from `think`/`synthesize` citations for the brain owner. |
| `feedback.alpha` | 0.1 | Learning rate; the citation signal uses half. |
| `feedback.max_ratings_per_hour` | 120 | Rating calls per client per hour. |
| `feedback.event_retention_days` | 30 | How long answers stay rateable. |
| `feedback.rating_prompt` | true | Show the one-line `how_to_rate` line on answers. |

Doctor `retrieval_feedback_health` warns when feedback is on, at least 50
answers were recorded and none was rated: the agent's host is probably not
showing tool result text, so the agent never sees the answer id. Its fix is
the read-only `gbrain feedback status --json`.

## Refusals

Every refusal carries `code`, `message` and `fix`; `gbrain errors <code>`
explains it offline.

### invalid_rating

The rating was not an integer from 1 to 5. Use 1 for wrong or useless evidence
and 5 for exactly the evidence needed.

### answer_pending

The answer was made moments ago and is still being recorded. Retry the same
call in about two seconds.

### answer_unavailable

The answer is not recorded: the id is unknown, the record was dropped, or it is
older than the retention window. Run the query again and rate the new
`answer_id`.

### answer_not_yours

The answer was returned to a different client. A connection rates only its
own answers.

### ref_not_in_answer

The page reference is not one of the pages the answer used. Use the refs the
answer listed (`source_id:slug`).

### ambiguous_ref

A bare slug matched pages in more than one source of that answer. Use the full
`source_id:slug` from the choices in the message.

### feedback_not_authorized

This connection may not change the shared ranking of the sources the answer
used. The brain owner grants an unrestricted write grant on that source; then
run the query again and rate the new answer (authority is checked when the
answer is made and again when it is rated).

### feedback_disabled

Ratings are off on this brain (`feedback.enabled=false`) or not learning
(`feedback.learn=false`). Only the brain owner turns them on, on the brain host.
