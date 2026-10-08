# Temporal edges: relationships with dates

GBrain records when a relationship between two pages started and ended, and
graph reads return what is true today unless you ask for history. "Who works at
acme-example?" lists current employees; former employees stay one parameter
away.

**Say to your agent:**
- *"Who works at acme-example now?"*
- *"Where did alice-example work in 2022?"*
- *"Show me former employees of acme-example."*
- *"Mark that alice-example left acme-example on 2025-03-01."*

## What carries a date

Relationship types fall into three groups:

| Group | Types | Behavior |
|---|---|---|
| State | `works_at`, `advises`, `yc_partner` | starts and can end; may have several stints (left and rejoined) |
| Event | `founded`, `invested_in`, `led_round`, `attended`, `discussed_in`, `cited` | happened on a date and stays true; hidden in as-of reads before that date |
| Reference | `mentions`, `source`, `owes_to`, `awaiting_reply_from`, untyped links, … | no temporal state; always returned |

Open-loop edges (`owes_to`, `awaiting_reply_from`) keep their own lifecycle in
open loops.

A schema pack adds its own relations to the first two groups with
`link_types[].temporal`:

```yaml
link_types:
  - name: reports_to
    inverse: manages
    temporal: state     # can end: reads return the manager true today
  - name: promoted
    temporal: event
```

The table above is the default; a pack declaration wins for its relation. The brain
uses the union of its active pack and every per-source pack, and `state` wins if two
packs disagree. `mentions` never carries a date. `gbrain schema lint` reports a
`temporal` on `mentions` (error), a built-in relation redeclared with different
semantics, and an inverse pair that disagrees (warnings). Natural-language cues
("left", "joined") date the built-in relations only; a pack relation takes its dates
from the explicit grammar (`Ended reports_to [[people/x]]`), frontmatter
`since`/`until`, and `add_link valid_from` / `valid_until`.

## How dates get recorded (no model calls)

Every write re-reads the page and records dated evidence for the relationships
the page states:

- **Timeline lines with a cue.** `- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)`
  ends `works_at acme-example` and starts `works_at widget-co` on that date. Cues are
  relation-specific: leaving a job does not end an advisory role. A cue only dates a
  relationship the page already states; it never creates one. "Moved from [A] to [B]"
  and "Left [A] for [B]" also start B.
  A cue moves a relationship only when it is about the relationship itself, so these
  lines change nothing: lines about investing, meetings or events ("Joined [Acme]'s
  Series B", "Back at [Acme] for an alumni dinner"), and references qualified by what
  follows ("[Acme]'s London office", "[Acme] alumni"). "[Acme]'s advisory board" is the
  one qualified form that dates `advises`. Write the explicit grammar below when such a
  line really is a job change.
- **The explicit line grammar**, inside a dated timeline entry. It names the relation
  and the target, so it works on its own, even after the old sentence is deleted:
  ```
  - **2025-03-01** | me — Ended works_at [[companies/acme-example]]
  - **2021-04-01** | me — Started advises [[companies/widget-co]]
  ```
- **Frontmatter `since` / `until`** on relationship objects:
  `company: [{ name: Acme, since: 2021-04, until: 2024-02-15 }]` (partial dates
  normalize to the first day of the month or year). List the company twice for a
  rejoin.
- **Past-tense prose.** "previously at", "former CTO of", "used to work at" mark the
  page's assertion as past ("has worked at" and "was promoted to CTO at" stay present).
  A relationship with no dated evidence at all then reads as ended at an unknown date;
  a dated start stays open until a dated end, whatever the prose says. On one page, a
  present-tense mention wins ("previously at Acme, now runs Acme's EU team" stays live).
- **Manual edges:** `add_link` accepts `valid_from` and `valid_until` (YYYY-MM-DD).
  Re-run `add_link` with `valid_until` to record that a relationship ended.

Dated evidence beats undated evidence from any page: a closure on a person's timeline
ends the relationship even if the company page still lists them under `key_people`.

## Relationship phrasings: what each wording means

Link typing reads what the sentence entails, nothing more. Each policy below is one
rule family with a stable rule id; `explainLinkType` (`src/core/link-extraction.ts`)
returns, for any page and target, the stated type, the pack rule, the deciding rule,
how its verb attached to this link, the alternatives it suppressed, the role prior,
and the cue behind every dated transition.

Rows marked **U1**, **U3** and **U4** are typing units that ship on: the preregistered held-out decision
`q2-parser-gaps-2026-10` confirmed U1 and the joint unit U34 (U3 with U4, measured together because U4 alone loses
as-of accuracy wherever board wording still types `works_at`). `ENABLED_TYPING_UNITS` in
`src/core/link-typing-units.ts` lists them. The unmarked rows are the core rules. Three more units were tested and not
shipped (see "Tested and not shipped" below); their code is removed, so those phrasings stay as the core rules read them.

| Policy | Supported examples | Type | Temporal evidence | Unsupported (stays as written) |
|---|---|---|---|---|
| Employment verbs (`verb.works_at`) | "works at [X]", "VP engineering at [X]", "joined as CTO", "head of sales" | `works_at` | "Joined/Left/Moved from [X]" date it (`cue.employment.*`) | a job title alone after the link ("Joined [X] as designer"), "<role> for [X]", "[X] (<role>)"; leave idioms ("parted company with", "handed in her notice at") and start framings ("first day at", "onboarding week at") date nothing |
| Advisory verbs (`verb.advises`) | "advises [X]", "is an advisor to [X]", "joined the advisory board of [X]" | `advises` | "Became an advisor to", "Started advising", "stepped down as advisor to" (`cue.advisory.*`) | "advising [X]", the `adviser` spelling |
| Investment verbs (`verb.invested_in`) | "invested in [X]", "led the seed", "wrote a check" | `invested_in` (event) | "Invested in", "led the … round" (`cue.event.invested_in`) | "as an angel investor" |
| Board seat (`verb.invested_in.board_seat`) | "board seat at [X]" | `invested_in` | event start | — |
| Role priors (`prior.investor` > `prior.advisor` > `prior.employee`) | a person page that says "partner at a venture fund", "is an advisor", "is a senior engineer at" | the prior's type, for person → company links no verb typed | none of its own | timeline and see-also links never get a prior |
| **U1** adviser wording (`unit.u1.adviser`) | "is an adviser to [X]", "serves as an adviser to", "now advising [X]", "technical adviser at [X]" | `advises` | as advisory verbs | "financial adviser at [Bank]" (a job title); a third party's role ("her husband is an adviser to"); an adviser phrase in another sentence or timeline entry |
| **U1** local negation (`unit.u1.negated`) | "not an advisor to [X]", "no longer advises [X]", "stopped advising [X]" | `mentions` for that occurrence | the dated "no longer advises" cue still ends an `advises` the page states elsewhere | negation more than a few words away |
| **U3** board wording (`unit.u3.board_wording`) | "board director at [X]", "independent director of [X]", "joined as an observer at [X]", "is also a board director at [X]" | `mentions` (a role prior may still apply) | none | board membership is not a type of its own |
| **U3** board seat without investment (`unit.u3.board_seat_without_investment`) | "holds a board seat at [X]" on a page with no investor prior | `mentions`; `invested_in` with an investor prior or "… as an investor" in the clause | event start when typed | — |
| **U4** not-employment starts | "Became an advisor at [X]", "Took an advisory role with [X]", "Took a board role at [X]" | unchanged | no `works_at` start (`cue.employment.start` skips advisory, board, investor, angel, observer roles) | "Joined the advisory board at [X]" still reads as a join; "head of advisory services" reads as advisory |
| Stays `mentions` | board membership with no investment or advisory statement; "started something new at [X]" with no role or employment verb; third-party subjects; negation; hypotheticals and plans | `mentions` | none | — |

### Tested and not shipped

| Unit | What it read | Why it does not ship |
|---|---|---|
| U2 ordinary roles | "<role> for [X]", "led design at [X]", "[X] (<role>)", "as <role>" after a join or sign-on, where every other rule gave `mentions` | measured jointly with U5 as U25 (U2 alone let the single-value pass close a former employer on the wrong date); on the confirmation set U25 added nothing over the package before it (difference 0.000 on all 200 pairs) |
| U5 leave idioms and exchange moves | "parted company with", "handed in her notice at", "called it a day at", "swapped [A] for [B]" as dated ends | part of U25, above |
| U6 start framings | "first day at", "onboarding week at", "began working at", "a new chapter at" as dated starts | failed the safety conditions at held-out selection (set I1 and W1), so it was never packaged: now-recall −0.012, as-of exact −0.011, and one new wrong transition by identity |

Development evidence and the reworks each unit went through: `docs/eval/decisions/q2-parser-gaps/dev-units.md`.

### Precedence

For one link occurrence: a typed relation line (`core/line-grammar.ts`) wins, then the
active pack's inference rules, then meeting attendance, then the verb rules in this
order: `founded` > `invested_in` (with the board-seat rule) > `advises` (with U1) >
`works_at`, then the Chinese rules. Among verb matches, only one that belongs to this
link counts: a match with another link between it and this one, or written right
before another link, belongs to that link. A unit veto (U1 negation, U3 board wording)
drops one match and inference moves to the next. Then the role priors (investor >
advisor > employee; person → company links only, never in timeline or see-also
sections). A link may keep a `mentions` row beside a typed one.

### Changing a spelling (contributor recipe)

1. **Where.** A verb spelling is a regex in `src/core/link-extraction.ts`
   (`WORKS_AT_RE`, `INVESTED_RE`, `ADVISES_RE`, …, listed in `CORE_VERB_RULES`). A cue
   is in `src/core/link-temporal-evidence.ts` (`EMPLOYMENT`, `ADVISORY`, `EVENT_START`).
   Unit rules, vetoes and cues live in `src/core/link-typing-units.ts`, each gated by
   `typingUnitEnabled('U<N>')`.
2. **Controls.** Add the spelling's look-alikes beside it as examples in
   `test/helpers/typing-unit-examples.ts` (or `test/link-extraction.test.ts` for a
   core rule): negation, a third party, a concurrent role, a rejoin, the same target
   twice, a link at the edge of the 240-character window, and an event line that uses
   the same words. Freeze the type, the tense, the transitions and the as-of result.
3. **Smallest tests.** `bun test test/link-typing-units.test.ts
   test/link-typing-explain.test.ts test/link-type-attachment.test.ts
   test/link-temporal-evidence.test.ts`; for a unit,
   `bun test test/link-typing-units-subsets.test.ts` (every unit subset, and world-v1
   typed as master with no unit and as the confirmed package with the shipped units, when a gbrain-evals checkout is
   beside this one). A typing change to shipped behavior needs `LINK_EXTRACTOR_VERSION_TS` bumped so existing pages
   re-extract.
4. **Precedence effects.** Run `explainLinkType` on the example: `rule` is what
   decided, `attachment` says whether the verb belonged to this link, and `suppressed`
   lists the rules it beat (`:outranked`), the matches that belonged to another link
   (`:other-link`) and unit vetoes. A new spelling for a higher-precedence verb steals
   every link whose window it reaches, including a verb on the neighboring timeline
   entry. Measure type steals and transitions by identity on development text with
   `bun scripts/q2-typing-dev.ts dump` and `compare` before you propose it.

## Reading

| Parameter | Meaning |
|---|---|
| (none) | relationships true today (UTC) |
| `status: "all"` | every relationship, each with `status`, `stints`, `recorded_at`, `retired_at` |
| `status: "ended"` | former relationships only (`get_links`) |
| `as_of: "2022-06-30"` | what was true on that day |
| `during: "2022"` | true at any point in a period (`2022`, `2022-03`, `2021..2023-06`) |

`get_links` takes all of them plus `link_type`; `get_backlinks` takes `status` (`live`,
`all`) and `as_of`; `traverse_graph` walks live relationships (read history with
`get_links` or `get_backlinks`). When a default read leaves relationships
out, the response carries a `former_relationships_hidden` notice with the exact call
that shows them, and `gbrain.temporal` response metadata with the count.

Recipe for "where did alice-example work in 2022":

```
get_links { slug: "people/alice-example", link_type: "works_at", during: "2022" }
```

Statuses in history reads:

| Status | Meaning |
|---|---|
| `live` | true at the reference date |
| `ended` | ended on a recorded date at or before the reference date |
| `ended_unknown_date` | stated as over, with no end date (excluded from as-of answers) |
| `not_started` | starts after the reference date |
| `disputed` | one page says it is current, another says it is over, no dates; returned live today and excluded from as-of answers |
| `event` | an event that has happened |
| `reference` | a plain reference with no temporal state |

The relational search arm follows the question's tense: "who works at" reads live
relationships, "who worked at" / "used to" reads history, "former employees of" reads
ended ones. Entity cards and `context_pack` keep every edge with its status and add a
relationship note, for example
`now: works_at widget-co (since 2025-03-01); ended: works_at acme-example (2025-03-01); summary may be stale: it still names acme-example`.
The same note follows a page into ambient turn context (appended to its synopsis) and into
compiled context files (a `relationships:` line under the excerpt), so an agent reading any
of them sees the ended relationship even when the summary has not been rewritten.

## The nightly relationship check

The dream cycle's `edge_contradictions` phase looks at subjects with two or more live
relationships of the same state type (two current employers). A chat model judges only
whether they can both hold now; date arithmetic decides which one ended and when: the
relationship that started earlier ends on the date the other started. Relationships
without a dated start are never closed; the proposal asks for a date instead.

A certified model passed a held-out run with no wrong closures, so with no explicit mode
its closures are applied as timeline lines, each undoable. Set
`dream.edge_contradictions.mode propose` to review every closure first.

The closure date is the newer relationship's start. When someone left one job and
started the next later, and only the "joined" lines are written, the earlier job closes
on the later start date: late, not wrong. An explicit end line
(`Ended works_at [[companies/x]]`) or a "left" line dates it exactly.

| Setting | Default |
|---|---|
| `dream.edge_contradictions.mode` | `apply` for certified models (`claude-haiku-4-5`, the utility default, plus `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6.1-sol`); `propose` for any other chat model; `off` without one |
| `models.dream.edge_contradictions` | utility tier |
| `dream.edge_contradictions.max_subjects` | 200 per cycle |
| `dream.edge_contradictions.max_usd` | $1.00 per cycle |

Proposals:

```
gbrain edge-proposals list            # open proposals and undated pairs
gbrain edge-proposals accept 12       # writes the closure line, re-derives the page
gbrain edge-proposals reject 12
gbrain edge-proposals undo 12         # removes the line it wrote
gbrain edge-proposals undo --all-applied
gbrain edge-proposals date 14 2024-05-01   # record when the newer relationship started
```

An applied proposal is one timeline line on the subject page:

```
- **2024-05-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)
```

Delete the line to reopen the relationship; the check records that and does not
propose it again until the evidence changes.

## Declared single-value relations

A schema pack can declare that a state relation has one current value per page, for
example a company brain where `works_at` means the one current employer:

```yaml
link_types:
  - name: works_at
    cardinality: one_per_from   # default: many
```

For a declared type the nightly check asks no model: the declaration already says two
live relationships cannot both hold. The chain rule orders the page's live
relationships by their latest dated start and ends each one on the date the next one
started, so an out-of-order import (Acme from January, Widget from March, then Gadget
from February) ends Acme in February and Gadget in March. Relationships without a dated
start, and two that start on the same date, stay open and appear in
`gbrain edge-proposals list`. Closures are recorded as proposals with model
`schema-pack:cardinality`; `gbrain edge-proposals accept <id>` writes one as the same
reversible timeline line.

- Only state relations take `cardinality`: the built-in ones (`works_at`, `advises`, `yc_partner`) and any type the
  pack declares `temporal: state`. `gbrain schema lint` rejects it elsewhere, because only state relations end.
- The declaration comes from the source's resolved pack. A child pack that redeclares
  the type replaces the whole entry, so it must restate `cardinality`.
- `gbrain schema cardinality-preview [--source <id>] [--json]` lists every page with
  more than one live relationship of a declared type and what the next dream cycle
  closes or leaves open. It writes nothing; run it before activating a pack that adds a
  declaration.
- `dream.single_value.mode` is `propose` by default: closures wait for review in
  `gbrain edge-proposals list`. `gbrain config set dream.single_value.mode apply` writes them
  automatically; `off` hands declared types back to the model judge. Held-out testing found
  wrong closures when an advisory timeline line ("Took an advisory role with X") counted as
  the start of a new job at X, so review proposals before accepting them.
- To stop further closures, remove the declaration. `gbrain edge-proposals undo <id>`
  (or deleting the line) reopens a relationship it closed.

Older gbrain releases reject a pack that uses `cardinality`, so set the pack's
`gbrain_min_version` to the release that adds it.

## Turning it off

- `gbrain config set graph.edge_validity off`: graph reads return every edge, as
  before. Dated evidence keeps being recorded, so turning it back on loses nothing.
- `gbrain config set dream.edge_contradictions.mode off`: no model-judged relationship checks
  (declared single-value relations follow `dream.single_value.mode`).
  Lines it already wrote stay until `gbrain edge-proposals undo --all-applied`.

## Health

`gbrain doctor --only edge_validity` reports relationships by status, relationships
whose state lags their evidence (the extract cycle sweeps them), pages that still
state a relationship their own timeline ended, and open proposals.
