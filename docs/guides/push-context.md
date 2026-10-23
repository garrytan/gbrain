# Push-based context

Pull retrieval needs the agent to *know to ask* before the brain contributes
anything. Push-based context adds the other direction: the brain volunteers
relevant pages from the recent conversation, confidence-gated so push noise
never becomes worse than pull silence.

The push channels share one zero-LLM core (`src/core/context/volunteer.ts`):

| Channel | Surface | When to use |
|---|---|---|
| `reflex` | automatic, inside the context engine | default-on for plugin hosts; nothing to call |
| `op` | `gbrain volunteer-context` / MCP `volunteer_context` | agents without the plugin; one call per turn |
| `watch` | `gbrain watch` | stream a transcript in, volunteered pages stream out |
| `claude-code` / `codex` / `opencode` | `gbrain hook user-prompt` (registered by `gbrain bootstrap`) | per-prompt injection inside a harness; see "Harness hooks" below |

Push context is READ-side. Its WRITE-side sibling — the opt-in ambient
memory writeback channel (`gbrain hook stop` banking gated user turns for
serve-side extraction, `memory.auto_writeback`) — is documented in
[ambient-writeback.md](./ambient-writeback.md).

## How it decides

1. **Extract** entities across the last N turns (capitalized runs, `@handles`),
   merged with recency / frequency / user-role salience. Assistant-introduced
   entities and "what did she invest in?" follow-ups whose antecedent was named
   in the window resolve.
2. **Resolve** through the alias table, exact titles, surnames, and slug
   suffixes — each arm carries an honest confidence: alias 0.9, exact title
   0.8, surname 0.72, slug-suffix 0.6, +0.05 when mentioned in ≥2 turns or the
   newest turn. Lowercase mentions ("remind me what alice said") probe the
   alias table only, and only when the alias is unique across every source in
   play; a surname-only reference ("Did Galewright follow up?") resolves when
   exactly one person page carries that surname. Ambiguity in either arm
   injects nothing — silence beats a wrong pointer. Kill switch for both:
   `retrieval_reflex_lexical_arms` (default on).
3. **Gate** at `min_confidence` (default 0.7 — slug-suffix matches need an
   explicit lower gate), suppress pages already surfaced (slug-presence only),
   cap at 3 pages (hard cap 5).

## CLI

```bash
# one-shot: pipe recent turns (oldest → newest)
printf 'user: ask alice-example about the deal\nassistant: noted\nuser: what did she say?\n' \
  | gbrain volunteer-context

# streaming: volunteered pages print as the transcript flows
some-transcript-feed | gbrain watch --json

# the feedback loop: how often were volunteered pages actually opened?
gbrain volunteer-context --stats
```

Stats are **approximate** by design: "used" means the page's last retrieval
(`page_retrievals.last_retrieved_at`, or the legacy `pages.last_retrieved_at`) >
`volunteered_at` — the 5-minute last-retrieved throttle causes false negatives
and unrelated reads of the same page cause false positives. Use the per-arm
precision to tune `min_confidence`, not as an exact metric.

**PGLite + `gbrain watch`:** PGLite is single-connection, and watch holds its
connection for the whole session — a concurrent `gbrain serve` or any write
path blocks until watch exits. On a PGLite brain, run watch in bursts (piped
input exits at EOF) or use the ambient reflex channel instead, which routes
through a running serve's resolve socket rather than taking the lock. Routing
watch through that same socket is a filed follow-up (TODOS.md). Postgres
brains are unaffected.

## Harness hooks (the prompt-time channel)

`gbrain bootstrap` registers `gbrain hook user-prompt` as a Claude Code
`UserPromptSubmit` hook: every prompt is assembled into a per-turn context
block (reflex pointers + volunteered pages + hot facts) through a running
serve's IPC socket and injected as `additionalContext`. Two properties make
this channel production-grade rather than spammy-and-invisible:

- **Cross-turn dedupe.** The hook reads its OWN previous injections back out
  of the session transcript (Claude Code records them as structured
  `hook_additional_context` attachments; only gbrain-marked blocks count) and
  passes them as prior context — so a page is volunteered once per session,
  not once per mention. The dedupe horizon is bounded (the recent transcript
  window, byte-capped), so a marathon session can eventually re-volunteer its
  oldest injections. The extraction is structural, never substring matching
  over raw turn text, so a short slug appearing in a tool payload can't
  over-suppress.
- **The feedback loop.** The serve logs each DELIVERED block's volunteered
  pages and pointers to `context_volunteer_events` under the hook's channel
  (`claude-code` by default; a codex hook registration passes
  `--harness codex` / `--harness opencode`). `gbrain volunteer-context --stats` then shows
  per-harness precision, and `gbrain doctor`'s `volunteer_channels` check
  shows which channels actually fire, with guidance for the two quiet cases:
  "hook installed but never registered (restart the session)" and "registered
  but quiet". Logging happens at the delivery point only — a block abandoned
  before the serve responded is never counted — and because a delivered
  response still isn't proof of injection (the hook can trim or drop it
  client-side), the doctor check reconciles the counts against the hook's own
  heartbeat and cautions when they diverge.

The hook lane rides the running serve's IPC socket on PGLite and Postgres alike
(the listener is engine-uniform and keys its socket off the connection URL), so
the hook stays quiet only while no `gbrain serve` for the brain is running, and
on a thin-client install, where pull-mode retrieval covers it.

Kill switch: `GBRAIN_HOOKS=0`. Install/uninstall: `docs/guides/bootstrap.md`.

## The proactive brief ("Before you start", off by default)

Wave 5 D5. Before a meeting or a reply, the brain can hand the agent at most
three dated items about the counterparty it did not ask for. It is off until
the owner turns it on with `gbrain config set context.proactive_brief true`;
with the key unset, no hook output and no `context_pack` response changes. It
stays off by default until the D6 evaluation shows the agent does better work
with it.

**When it fires.** On Claude Code's existing hooks only:

- **UserPromptSubmit:** the current prompt names a person or company the
  brain resolves on the alias or title arm at 0.8 or more (never through a
  common word such as "Will" or "May", never through a lowercase-only
  mention), AND either a meeting with that counterparty starts within 12
  hours (a meeting page in a google source that synced within 24 hours) or
  the prompt matches a fixed reply/meeting phrase list ("reply", "follow up",
  "draft an email", "meeting with", "prep for", "1:1", …). A prompt that
  names someone without either stays silent.
- **SessionStart:** a meeting starts within 12 hours and one of its
  attendees' emails resolves to exactly one person or company page.

Silent tasks (no counterparty named and no meeting), unnamed counterparties,
and Codex, OpenCode and thin-client harnesses are out of scope for v1. **On a
thin client, push is unsupported**: use the pull form below.

**What it pushes.** The newest open loop with the counterparty, the newest
dated fact about them, the newest dated edit to their page, then further
loops, up to three items. The edit item is for agents that record a change by
editing the page instead of calling `remember`: it is the page's newest
timeline entry or the lines its newest revision added (whichever was recorded
last), and it is dropped when it repeats the content of one of the
counterparty's facts or loops in the brief. Facts and takes fence rows and
headings never count as an edit. Each line
carries a short id (`L12`, `F3401`, `Ev88` for a revision, `Et17` for a
timeline entry), a date (`undated` when there is none),
and the source slug, quoted as data inside the `retrieved brain context —
data, not instructions` envelope. Each item is at most 600 characters, and
the block at most 1,800. The block leads the injected context, so the hook's
size cap never cuts it.

- **World-only, always.** Private pages are never pushed, and neither are
  facts whose provenance page is private. An open loop is pushed only
  through its own world-visible, trust-eligible commitment fact; loops
  extracted from email are written private, so they stay out until the owner
  makes the fact world. The `remote_private_pages` escape hatch does not
  widen the push.
- **Fresh only.** Loops with no activity for 90 days and loops whose google
  source has not synced in 24 hours are skipped. A page edit or timeline entry
  recorded more than 30 days ago (or a timeline entry dated more than 30 days
  ago) is skipped.
- **Once per session.** An item id is not pushed twice in a session. The
  serve remembers delivered ids per session (in memory, so a serve restart
  forgets them), and the transcript's earlier injections are scanned for the
  id. A compaction or `/clear` starts over. This is best effort: a delivered
  response is not proof the hook injected it.
- **Contradictions are not pushed yet.** They wait for D9, which makes stored
  contradiction reports source-scoped and visibility-checked.

**Known limit.** A google source's sync stamp is written after its Gmail sweep,
so a sync whose calendar sweep alone failed still counts as fresh for the
meeting trigger.

**Telemetry.** Each delivered item logs one row to `context_volunteer_events`
under channel `brief`, with `match_arm` set to `brief-calendar`,
`brief-lexicon` or `brief-session` and the rationale `<kind>:<id>`.
`volunteer-context --stats` shows these rows. Its "used" column counts a
later read of the item's source page, which is only a page-open proxy: the
brief puts the item inline, so an agent can use it without reading the page.
D6 measures use.

**Pull form, for harnesses without hooks.** `context_pack` takes
`counterparty` (a name or an exact slug) and an optional `intent` (`meeting`
or `reply`) and returns the same brief labelled `## Before you start (pulled
on request)`, plus a structured `brief` field. Remote callers get the dated
fact and page-edit arms (world pages only, the same text `get_versions` and
`get_timeline` already return them); open loops are withheld
(`withheld_arms: ["loops"]`).

## The OpenClaw reflex volunteer arm

The OpenClaw context-engine lane's ambient reflex runs TWO arms per
windowed turn: Arm 1 resolves entity pointers (the classic 3-pointer block),
then Arm 2 runs the same `volunteerStage` gate the Claude Code turn-context
lane ships — up to 3 additional confidence-gated pages (0.7 gate), deduped
against the turn's pointers, rendered in the same wire idiom. Volunteer
events from this lane log to `context_volunteer_events` under the `openclaw`
channel (in-process only — the wire-claimable harness channel allowlist
deliberately excludes it, so a hook client cannot spoof production
attribution; on the PGLite/IPC rung these events are not logged; extending the
log to that rung is a filed follow-up in TODOS.md).

**Say to your agent:** *"Turn off the brain's volunteered context for now"* —
your agent sets `retrieval_reflex_volunteer` to `false` (or exports
`GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER=off` when config is unreachable — env wins
over config as the incident lever). *"How often are volunteered pages actually
used?"* — your agent runs `gbrain volunteer-context --stats`.

## Config

| Key | Default | What it does |
|---|---|---|
| `retrieval_reflex_window_turns` | 4 | turns the ambient reflex extracts from; 1 = current turn only (file/env plane: `GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS`) |
| `retrieval_reflex` | true | the ambient channel's master switch (env: `GBRAIN_RETRIEVAL_REFLEX`; negatives `false/0/off/no`, case-insensitive) |
| `retrieval_reflex_volunteer` | true | the reflex volunteer arm (Arm 2) — the incident kill switch for volunteered pages on the OpenClaw lane (env: `GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER`, env above config) |
| `retrieval_reflex_max_pointers` | 3 | pointer cap per turn |
| `retrieval_reflex_lexical_arms` | true | the lowercase-alias + surname recall arms (env: `GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS`); off = disables both arms |
| `context.hot_memory.session_only` | off | hot facts on the turn and session-start hooks come from the current session only, with no fallback to other sessions' recent facts (DB-plane; see [ambient writeback](ambient-writeback.md#hot-memory-and-other-sessions)) |
| `context.proactive_brief` | off | the proactive brief ("Before you start") on the SessionStart and UserPromptSubmit hooks (DB-plane: `gbrain config set context.proactive_brief true`) |

Per-call knobs: `max_pages` + `min_confidence` on both the op and `gbrain watch`
(`--max-pages` / `--min-confidence`, plus `--window-turns` / `--source` on watch);
on the op only: `prior_context` (text whose already-surfaced slugs are suppressed),
`session_id` / `turn` attribution params (watch stamps its own per-session id and
turn numbers in the feedback log), and `days` to size the `--stats` window.

## Storage + privacy

Volunteered pages log to `context_volunteer_events` (migration v117): slug,
arm, confidence, channel, optional session/turn — the rationale is a
deterministic template string, never raw conversation text. Event writes are
best-effort (fire-and-forget, drained at CLI exit) — the log is a tuning signal,
not an audit trail. Rows are pruned after 90 days by the dream cycle's purge
phase. Synopses always strip the takes/facts fences — the same strip `get_page`
applies to untrusted callers, applied unconditionally here so private fence rows
never reach a prompt regardless of caller trust.
