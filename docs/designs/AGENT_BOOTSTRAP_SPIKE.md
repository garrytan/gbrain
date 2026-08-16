# Agent Bootstrap — Spike Instrument (build order 0)

Manual validation that gates door-1 (Codex/ChatGPT desktop) ship. Run on a machine
the maintainer does not own, with fresh accounts. Owner: the maintainer. Timebox:
~1 week wall-clock. Outcomes feed the design doc's gate
([AGENT_BOOTSTRAP_DESIGN.md](AGENT_BOOTSTRAP_DESIGN.md)).

## Exit questions and pass bars

**#1 (blocking) — the write seam.** What reliably persists memory per turn/session
on the ChatGPT-desktop surface?
- Protocol: run 20 sessions across ≥3 days of ordinary use. Each session must
  produce at least one durable write (a page/fact retrievable in the NEXT session).
- Pass: 0 durable-write failures in 20 sessions; else extend to 50 and log every
  failure's cause (crash, sleep, approval friction, format drift, model forgot).
- Below the bar → door 1 demotes to documented beta (Codex CLI unaffected).

**#2 — the read seam.** Is injected/pulled context demonstrably present at turn
start? Pass: context block present (or the degraded pull-mode documented as
door-1's v1 behavior). Pass expands the greeting digest to door 1.

**#3 — capability surface.** Record, with screenshots: local folder access
(yes/no/how), MCP registration path (config file? `codex mcp add`? UI?), approval
taps for each toolchain step (count them), connector availability for
email/calendar (yes/no/degraded).

**#4 — quota.** Per harness the doors run on (Claude Code: Max plan; Codex: the
ChatGPT plan): log each day's usage-meter readings during the pilot.
- Load model: ordinary sessions + hooks + one session-triggered schedule.
- Pass: a p90 day consumes ≤10% of the weekly allowance (per-door; one harness
  failing cuts schedule scope for that door only).
- Measurement: the harness's own usage UI (screenshot at day start/end) + a tally
  of sessions/turns from the transcript dir. No telemetry — this is a manual
  instrument by design.

**#5 — TTFM baseline.** One full paste-to-verified install, timed. Count every
human action (paste / auth click / interview answers / consents / approval taps).
Toolchain download time recorded separately (excluded from the 15-minute target).

## Pilot metrics (continue for 2 weeks after the spike)

Per week, from session review (screen recordings + self-report — no telemetry):
correct-write rate (things worth remembering that got written), correct-recall
rate (recalls that were right), false-memory incidents (recalled things that were
wrong), correction round-trips (corrections that stuck as standing rules). The
0-failures-in-20 bar is the minimum to START the pilot, not the proof — the pilot
is the sample.

## Log template (one row per session)

| # | date | door | duration | writes attempted | writes durable | recalls right/wrong | approvals | notes |
|---|---|---|---|---|---|---|---|---|

## Deliverable

A filled copy of this doc committed as `AGENT_BOOTSTRAP_SPIKE_RESULTS.md`
(scrubbed: no real names beyond the maintainer, no account identifiers), plus the
gate decision recorded in the design doc: door-1 ships full / ships as documented
beta / schedule scope cut per quota.

**Gate status:** not yet run — no `AGENT_BOOTSTRAP_SPIKE_RESULTS.md` is committed,
so no gate decision is recorded and door 1 has not been promoted past the
documented-beta bar by this instrument. Update this line when the results land.
