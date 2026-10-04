# Final spec: agent-first operator wave

Status: approved plan (GBRA-42) with the CEO, DX and Eng obligations folded in. This document is self-contained: an
implementer follows it lane by lane without reading the review record. Where it differs from
`agent-operator-plan.md`, this document wins (fold precedence was Eng > DX > lane text > CEO).

- Repo: `garrytan/gbrain`. Base branch `capy/agent-operator-wave`, cut from `capy/foundations-1` at `c838c630`
  (contains fix wave 8 and wave 8 lane H's pricing builder `src/core/budget/no-pricing.ts` + `gbrain pricing`).
  `capy/foundations-1` has since moved one restamp commit (`bd395c5e`, v0.60.37.0); wave 8 takes v0.60.36.0.
- Version: PATCH, v0.60.38.0 or the next free PATCH at ship time (auto-allocate past collisions, sync every stamp).
- Code anchors below were checked on `origin/capy/agent-operator-wave`; line numbers are approximate (`~`).

---

## Problem

gbrain is operated by AI agents (Claude Code, Codex, OpenClaw, Grok Bot, MCP clients) on a user's behalf, but much of
its code, errors and docs assume a human at a terminal. The agent-first pieces that exist (Google connect's
`[SHOW USER]` + `next_action`, the memory-verb error contract with required `suggestion`, the `GBRAIN_DB_ACCESS`
classifier, `repair`'s preview/apply, F0's refresh refusals with code/cause/fix/docs) are islands. The GBRA-42 audit
measured:

1. **Errors don't say what to do next.** 85% of `OperationError` sites have no `suggestion`; non-`OperationError`
   throws reaching MCP become a bare `internal_error` on 127 of 134 remote-visible ops. Five remediation types exist and
   dispatch understands one. Receipts replace the site's suggestion with a generic line. 80 thrown codes are undeclared.
   The thin client's scope hint never fires (`missing_scope` vs the server's `insufficient_scope`).
2. **Consent is keyed on "is there a terminal".** `doctor --remediate` runs paid/mutating work for non-TTY callers with
   no `--yes` and no cap (`src/commands/doctor/remediate.ts:~260`). 52 refusals say "re-run with `--yes`"; about one
   says the decision is the user's. `reindex-frontmatter --json` bypasses its gate; `advisor --apply` has no
   non-interactive path.
3. **Commands hang or silently no-op without a terminal.** Six stdin readers lack EOF/timeout; `bootstrap harness`
   exits 0 having written nothing; `connectors auth --try-oauth` blocks 10 minutes headless.
4. **The CLI machine contract is unreliable.** `--json` prints human text or nothing on failure for several commands;
   five JSON error shapes; 49 of 112 commands have a stub `--help`; `--limit abc` exits 0; exit codes are overloaded.
5. **Capability advice is recomputed per surface and contradicts itself.** "Turn on embeddings" has six renderings on a
   keyless brain, one destructive (`mv brain.pglite …`, loses DB-only facts). Doctor scores a sanctioned keyless brain
   40/100. PGLite jobs queue with no worker while `jobs stats` blames a wedged supervisor.
6. **Agent-visible channels are wrong.** Degraded (keyword-only) recall is reported only via `_meta`/stderr, which the
   model doesn't see. A second `gbrain serve` or a missing brain exits before the MCP handshake. Seven local-only tools
   are listed on stdio but always refuse there.
7. **Interop coaching is suppressed exactly when an agent operates.** Nudges, hints and the post-upgrade banner are
   TTY-only; the advisor is off over MCP; init assumes Claude Code and plants a fake user fact.
8. **Docs have no single agent error protocol**; six marker formats; troubleshooting has no consent or verification
   columns; error docs pointers are repo-relative.

An agent that gets `internal_error` retries or gives up; one told "pass --yes" spends money or destroys data without
asking; one that hangs looks broken; one that can't see degraded mode tells the user "you have no notes on X".

---

## Goal and principles

Every gbrain surface (MCP tool result, CLI human output, CLI `--json`, doctor/advisor/readiness, docs, skills) assumes
the operator is an agent and gives it, for every failure, refusal, degradation and recommendation, one **Action**:

1. **What happened**: a stable canonical `code` (+ `reason` where one code covers several causes) and one sentence.
2. **Why**: enough for the agent to explain it and weigh tradeoffs.
3. **The exact next step**: `fix.argv` (CLI, explicit `--brain`/`--source` routing, positionals after `--`) and/or
   `fix.mcp` (tool + arguments), real values filled in, rendered for the caller's surface, naming only tools that
   `isCallable` on that surface.
4. **Who acts and whether to stop**: `fix.consent` (set of effects `paid | destructive | credentials | egress |
   persistent_install`), `fix.actor` (`agent | user | host_admin | provider`), `fix.requires_exclusive`, and a derived
   `next ∈ run | ask_user | tell_user_to_run | wait | report` computed only at render time from effects, actor,
   transport, callability and preapprovals. Agents follow `next`; `user_message` is the relay text.
5. **How to verify**: `fix.verify`, always a read-only invocation (usually `gbrain doctor --only <check> --json`).
6. **Proactive interop coaching**: when gbrain sees the setup limiting the user's goal in the current call, it says so
   in a channel the model sees (a prefixed extra content block on MCP), with the fix and what to tell the user, within
   a per-session budget, mutable.

**Consent honesty.** An agent can always pass `--yes`. Consent gates force a stop and supply relay text; they cannot
prove a human agreed (only memorable's withheld-`--yes` gate is hard). The enforced rails are spend caps, approvals
bound to a persisted selection and plan hash, and backups/snapshots before destructive work. Docs never claim
enforcement.

**Humans keep a good experience**: the same data renders as readable text on a TTY (fix line second).

**Compatibility (contract v1).** `contract_version: 1`, additive-only (MEMORY_VERBS rule):
- No existing field changes type or disappears. An existing `error` wire value never changes; the canonical value rides
  a new `code` field (new clients read `code`, falling back to `error`).
- MCP success `content[0]` stays byte-identical (bare arrays included). Notices ride extra text blocks with a fixed
  prefix line plus `_meta.gbrain_notices`. Every `isError` result is exactly one content block; its notices go in an
  additive `notices` key inside the envelope.
- Legacy nested shapes (`code-def`, `phase-containment.ts:~63`) keep their nesting and gain sibling `code`/`fix`.
- Legacy advice names stay on existing payloads as documented aliases.
- Removal of legacy shapes needs a written support policy and consumer evidence (TODOS).

**Standing project rules.** New/changed features default ON on upgrade (opt-out) with real rails. An unpriced model
under a derived or default cap warns and runs; under a user cap it blocks and the refusal tells the agent to look up
the per-token rate (for example by web search) and register it with `gbrain pricing set`, then retry. Trust boundary
stays fail-closed (no stdio trust widening). One fix-wave PR. PATCH bump.

---

## Delivery shape

**One PR** ("agent-first operator wave") from a collector branch on `capy/agent-operator-wave`, parallel lane task
branches, one CHANGELOG entry. PR targets `master`; retarget/rebase as wave 8 (v0.60.36.0) and Foundations 1
(v0.60.37.0) merge. Rebase onto `capy/foundations-1` (then `master`) only at fixed points: after the Lane A freeze,
before Lane H, and before ship. Coordinate landings with the GBRA threads that own wave 8 and Foundations 1.

**Pricing.** Wave 8 lane H is already on the base: A4 and C consume `noPricingGuidance()` / `noPricingMessage()` /
`pricingSetCommand()` (`src/core/budget/no-pricing.ts`) and `gbrain pricing set` directly. Fallback note only: if a
rebase ever drops that builder, the paid path keeps today's behaviour behind the same seam until it returns.

**Order.**
1. Lane A lands first and **freezes**: the A0 interfaces, golden envelopes under `test/fixtures/agent-contract/v1/`,
   the notice wire format and the exit table. No lane B–G work starts before the freeze commit.
2. Re-measure the day-zero doctor baseline on the collector SHA before Lane E starts.
3. Lanes B–G in parallel (B10 last, after wave 8's rewrites of its files).
4. Lane H (deterministic journeys), then Lane I (measured outcomes, release gate).

**Test registration.** Every new E2E/serial test is registered in `scripts/e2e-test-map.ts` and the weights files
(`scripts/e2e-weights.json`, `scripts/serial-weights.json`, `scripts/test-weights.json`, regenerated with
`scripts/mine-shard-weights.ts`). New guards are registered in `scripts/guards-manifest.tsv` with fixtures under
`test/fixtures/guards/<guard>/{bad,good}/`.

**Community PRs absorbed** via the RELEASING.md "Community PR wave process": read each diff, cherry-pick or
re-implement inside the owning lane, keep the contributor's `Co-Authored-By:` trailer, keep or port their tests, and
after the wave merges close each PR with a comment naming the commit that supersedes it.

| PR | What | Folded into |
|---|---|---|
| #5952 | `readOnlyHint` for read-only ops | A2 op metadata: extend wave 8's central `toolAnnotations()` in `src/mcp/tool-defs.ts` from the explicit `mutating:false` tags. No parallel derivation path. |
| #5953 | `--tools-json` emits `scope`, `required_scopes`, `mutating`, `local_only` | A2 op metadata (`src/commands/tools-json.ts`, golden `test/fixtures/goldens/cli/tools-json.json`), plus `idempotent` |
| #5954 | `list_pages` tells MCP callers when clamped/truncated | F3b: `_meta.pagination` kept as data; the model-visible block becomes the `listing_truncated` notice. Builds on wave 8's `listColumnsOnly` narrowing (`src/core/ops/pages.ts:~556`). |
| #5936 #5934 #5933 #5931 #5930 #5937 #5909 | numeric-flag validation (jobs submit, extract-conversation-facts, eval-run-all, sync `--interval`, connectors sync, reindex, book-mirror) | D4 typed validation (Tier 1 as direct fixes, re-expressed through the D3 spec in Tier 2 keeping their tests) |
| #5950 | thin client refuses/routes every engine-opening command at `connectEngine` | D6 |
| #5949 | thin client reports a 429 `/token` mint as rate-limited | B5 |

**Tier manifest** (each tier includes its dependencies; Tier 3 moves to the next wave if the collector is not green
by the agreed date, recorded in TODOS.md; the PR body lists tiers and what shipped):
- **Tier 1 (ships regardless):** A0 freeze, A1, A2-core (registry for Tier 1 codes, op `mutating`/`idempotent` tags,
  `isCallable`, annotations, #5952, #5953), A3, A4 (per-run preapproval), A5, A6, A7, B1, B5 (+#5949), C1, C2, C3, C5,
  C6, C10, D1, D2 for `init`/`doctor`/`sync`/`embed`/`doctor --remediate` (guard mode included), D4 community fixes,
  D6 (#5950), E2, E11, F3, F4, the first-session slice (G5, day-zero doctor, `doctor --only`, `harness_wiring` smoke),
  the scanner with the rules Tier 1 needs (B9 skeleton, C8 reader rules, `stdio:'inherit'` ban, registry completeness
  for Tier 1 codes), the pending-migration observational-startup fixture, H1a, H2, I.
- **Tier 2:** rest of A2 + generated docs, B2–B4, B6–B9, C4, C7–C9, `max_usd_per_day` preapproval, D2 rest,
  D3-core (21 shadowed helps, 7 ops-critical curated helps, did-you-mean), D4 spec-driven, D5, E1, E3–E10, F1, F2,
  F3b (#5954), F5–F9, G1–G6, H1b, H3, H4.
- **Tier 3:** B10, D3 rest, F10 description rewrite, G7.

### Lane ownership and files

| Lane | Main files / dirs | Depends on |
|---|---|---|
| A Foundations | new `src/core/agent-output.ts`, `src/core/consent.ts`, `src/core/interaction.ts`, `src/core/readiness.ts`, `src/core/ops/callable.ts`; `src/core/error-catalogue.ts` (→ registry), `src/core/ops/contract.ts`, `src/core/errors.ts`, `src/core/exit-codes.ts`, `src/core/cli-force-exit.ts` (`--json` mode, child helper), `src/core/budget/budget-tracker.ts`, `src/mcp/tool-defs.ts`, `src/mcp/dispatch.ts` (notice channel, error fallback), `src/core/mcp-client.ts`, `src/commands/tools-json.ts`, `src/core/operations.ts`/`src/core/ops/*` (tags only), `scripts/check-agent-contract.ts`, `test/fixtures/agent-contract/v1/` | base only |
| B Error sweep | `src/core/ops/**` handlers, `src/mcp/server.ts:~487,490`, `src/core/persistence/**` receipts, `src/commands/serve-http-mcp.ts` scope/unknown-op paths, `src/mcp/http-transport.ts`, `src/core/mcp-client.ts` (scope, 429), `src/commands/remote.ts`; B10's seven files | A frozen |
| C Consent + interaction | `src/commands/doctor/remediate.ts`, `pglite-repair`, `reinit-pglite`, `migrate-embeddings`, `decide`, `connect`, `dream`, `enrich`, `book-mirror`, `reindex-*`, skillpack, `advisor.ts`, `report`, capture, `connectors/auth`, `notability-eval`, `bootstrap.ts` (harness), `src/core/brainstorm/orchestrator.ts`, `src/core/progressive-batch/orchestrator.ts`, `src/core/eval-contradictions/cost-prompt.ts`, `src/core/minions/budget-meter.ts`, `src/core/minions/delegated-policy.ts`, `src/core/cli-util.ts`, `src/core/confirm-prompt.ts` | A frozen |
| D CLI contract | `src/cli.ts` (top-level catch, `parseOpArgs` `--`, fatal seam), `src/cli/command-table.ts`, new `src/cli/help/<command>.ts`, `src/core/cli-flag-registry*`, D2 command files, community numeric-flag files, thin-client routing | A frozen |
| E Readiness consumers | `src/commands/doctor/**`, `src/commands/doctor.ts`, `src/cli/commands/doctor.ts`, `src/core/remediation/**`, `src/core/doctor-categories.ts`, `src/commands/remote.ts`, features/onboard, jobs, sync, backup checks, `src/commands/migrations/**`, autopilot, `src/commands/config.ts:~915-935` | A frozen; day-zero baseline re-measured |
| F MCP interop | `src/mcp/server.ts` (instructions, status mode), `src/mcp/capabilities.ts`, `src/commands/serve-http*.ts`, `src/mcp/dispatch.ts` (notice producers only, via `emitNotice`), `src/core/ops/pages.ts` + `ops/list-pages-pagination.ts` (#5954), advisor publish, onboarding nudges | A frozen; E for readiness producers it renders |
| G Docs + skills | `docs/protocol/AGENT_OPERATOR_v1.md`, `docs/guides/{error-codes,exit-codes,troubleshooting,remote-mcp,google-connect}.md`, `docs/mcp/**`, `AGENTS.md`, `INSTALL_FOR_AGENTS.md`, `BOOTSTRAP_FOR_AGENTS.md`, `CLAUDE.md`, `llms*.txt`, `skills/**`, doc-drift guard, CHANGELOG table | A goldens; content from every lane |
| H Journeys | `test/**` journey + E2E files, `scripts/e2e-test-map.ts`, weights files | B–G |
| I Measured outcomes | new `evals/agent-operator/` (scenarios, container, runner), mirror into gbrain-evals | H; immutable candidate package |

Shared-file rule: `src/mcp/dispatch.ts` and `src/mcp/server.ts` are touched by A, B and F. A owns the channel and
envelope code; B touches only the listed throw sites; F adds producers through `emitNotice` and the status mode.
`src/cli.ts` belongs to D; A adds only the `jsonRequested`/guard installation lines.

---

## Lane A — Foundations (one shared contract; everything else consumes it)

### A0. Frozen interfaces

Landed and frozen before lanes B–G start. Changing a frozen signature after the freeze needs a note in the collector
PR and a ping to every lane that consumes it.

```ts
// ── src/core/agent-output.ts ───────────────────────────────────────────────
export const CONTRACT_VERSION = 1 as const;

export type Effect = 'paid' | 'destructive' | 'credentials' | 'egress' | 'persistent_install';
export type Actor = 'agent' | 'user' | 'host_admin' | 'provider';
export type Next = 'run' | 'ask_user' | 'tell_user_to_run' | 'wait' | 'report';
export type Transport = 'cli' | 'stdio' | 'http';
export type Surface = 'verbs' | 'starter' | 'full';
export type ErrorClass = 'caller' | 'consent' | 'retryable' | 'unavailable' | 'server' | 'host_only';

export interface McpCall { tool: string; arguments: Record<string, unknown> }

/** A value the agent must obtain before running (e.g. a model's price). argv holds `<name>` only for these. */
export interface ActionInput { name: string; how: string }

/** Stored/constructed form. Never carries `next` or `command`: both are computed at render time. */
export interface Action {
  argv?: string[];              // ['gbrain', …]; explicit --brain/--source; positionals after '--'
  mcp?: McpCall;                // dropped at render time unless isCallable on the caller's surface
  consent: Effect[];            // [] means no consent needed
  actor: Actor;
  why: string;
  user_message?: string;
  verify?: { argv?: string[]; mcp?: McpCall };   // read-only invocations only (scanner-checked)
  docs?: string;                // anchor, rendered absolute by docsUrl()
  requires_exclusive: boolean;  // needs the brain's single-writer lock
  inputs?: ActionInput[];
  plan_hash?: string;           // destructive/maintenance: binds the approved selection
  preview_argv?: string[];
  then?: Action;                // second step of a two-step plan (e.g. stop the owning serve, then run)
}

/** Wire form: what an agent reads. */
export interface RenderedAction extends Omit<Action, 'then' | 'docs'> {
  command?: string;             // shell-quoted from argv by shellQuote(); never hand-built
  next: Next;
  docs?: string;                // absolute URL
  then?: RenderedAction;
}

export type NoticeKind = 'safety' | 'degraded' | 'coaching' | 'ask' | 'info';
export interface DecisionOption { id: string; label: string; argv?: string[] }
export interface Decision { id: string; question: string; options: DecisionOption[]; default: string; default_reason: string }

export interface Notice {
  code: string;                 // registry code (snake_case)
  kind: NoticeKind;
  why: string;
  fix?: Action;
  user_message?: string;
  decisions?: Decision[];
}
export interface RenderedNotice extends Omit<Notice, 'fix'> { fix?: RenderedAction; contract_version: 1 }

/** The one error envelope (CLI --json document, MCP isError content[0], HTTP bodies). */
export interface AgentEnvelope {
  error: string;                // legacy wire value, frozen; equals `code` for codes new in this wave
  code: string;                 // canonical registry code
  reason?: string;
  message: string;
  suggestion: string;           // prose; when `fix` exists, its rendered command is appended (never disagrees)
  why?: string;
  fix?: RenderedAction;
  docs?: string;                // absolute, version-pinned URL
  docs_cmd: string[];           // ['gbrain', 'errors', '<code>']
  class: ErrorClass;
  retryable: boolean;
  notices?: RenderedNotice[];
  contract_version: 1;
  // pre-existing keys keep their names and meaning:
  detail?: string; protocol_version?: 1; write_request?: unknown; write_error?: string;
}

export interface RenderContext {
  transport: Transport;
  surface?: Surface;
  isCallable(opName: string): boolean;   // bound from ops/callable.ts for this caller
  preapproved(effects: Effect[], estUsd?: number | null): boolean;
  principal?: string;                     // authenticated principal on http/stdio
}
export function renderAction(a: Action, ctx: RenderContext): RenderedAction;
export function deriveNext(a: Action, ctx: RenderContext): Next;            // the published decision table
export function renderNotice(n: Notice, ctx: RenderContext): RenderedNotice;
export function noticeBlock(n: RenderedNotice): string;                     // MCP extra text block
export function docsUrl(anchor: string): string;
export function shellQuote(argv: readonly string[]): string;
export function paramRef(ctx: { transport: Transport }, param: string): string;   // `no_pull: true` vs `--no-pull`
export function redactForTransport<T>(value: T, transport: Transport): T;          // one pass; http strips paths/PIDs/key names/posture

export interface AgentErrorContext {
  transport: Transport;
  op?: string;                  // MCP op name
  command?: string;             // CLI command
  mutating?: boolean;
  idempotent?: boolean;
  outcome?: 'not_started' | 'failed' | 'unknown' | 'committed' | 'pending';
  render: RenderContext;
}
/** Total: never throws; on an internal fault returns the prior generic envelope and logs the class (E11). */
export function toAgentError(e: unknown, ctx: AgentErrorContext): AgentEnvelope;

export interface CliErrorRender { stdout?: string; stderr?: string; exitCode: number }
/** Pure: callers write the strings. TTY order: `Error [code]: msg` / `Fix:` / `Why:` / `Docs:`. */
export function renderCliError(e: unknown, opts: { json: boolean; command: string; tty: boolean }): CliErrorRender;

/** Attached to OperationContext (MCP) and the CLI dispatch context. */
export interface NoticeSink { emitNotice(n: Notice): void }

// ── src/core/ops/contract.ts (additions) ───────────────────────────────────
export interface OpErrorOpts { reason?: string; why?: string; fix?: Action; docs?: string; detail?: string }
export function opError(code: RegistryCode, message: string, suggestion: string, opts?: OpErrorOpts): OperationError;
// OperationError gains optional `reason`, `why`, `fix`, `notices`, `contract_version`; toJSON() adds `code` and
// the new keys only when set; `error` keeps its current value. Static escape:
//   OperationError.bare(code: RegistryCode, message: string, reason: string): OperationError
// `RegistryCode` is the registry's code union; OperationError.code is typed with it internally.
// Operation gains `idempotent?: boolean`; the walker test requires every op to set `mutating` and `idempotent`.

// ── src/core/ops/callable.ts ───────────────────────────────────────────────
export interface CallableContext {
  transport: Transport; surface: Surface; scopes: readonly string[];
  publishGates: Record<string, boolean>; allowedOps?: ReadonlySet<string>;
}
/** The one predicate behind tools/list AND dispatch. */
export function isCallable(op: Operation, ctx: CallableContext): boolean;

// ── src/core/consent.ts ────────────────────────────────────────────────────
export type CapSource = 'derived' | 'default' | 'user';
export interface Authorization {
  consented_effects: Effect[];
  cap_usd: number | null;       // null only when no paid effect
  cap_source: CapSource | null;
  via: 'yes' | 'max_usd' | 'tokenmax' | 'preapproval' | 'apply_flag' | 'non_interactive_flag' | 'tty_prompt';
  approval_token?: string;      // destructive: binds the persisted approved selection
}
export interface ConsentRequest {
  command: string;
  effects: Effect[];
  actor: Actor;
  what: string; why: string; risk: string;
  user_message: string;
  argv: string[];               // the exact command that runs once approved
  preview_argv?: string[];
  est_usd?: number | null;
  plan_hash?: string;
  selection?: unknown;          // destructive: persisted with the approval (A4 destructive rail)
  args: readonly string[];      // raw argv, for --yes/--max-usd/--expect/--apply/--trust/--non-interactive
}
/** CLI command handlers only. Resolves with the authorization or throws OperationError('confirmation_required'). */
export function requireConsent(req: ConsentRequest): Promise<Authorization>;

// ── src/core/interaction.ts ────────────────────────────────────────────────
export interface InteractiveProbe {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean; stdoutIsTTY?: boolean;
}
export function isInteractive(probe?: InteractiveProbe): boolean;
export function agentProcessMarker(env?: NodeJS.ProcessEnv): string | null;   // never CODEX_HOME

export type LineRead = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'timeout' };
/** Prompt read: stderr prompt; EOF/timeout = decline. Returns {kind:'eof'} at once when !isInteractive(). */
export function readLine(opts: { prompt: string; timeoutMs?: number /* default 300_000 */ }): Promise<LineRead>;

export type StdinRead =
  | { kind: 'data'; text: string }
  | { kind: 'empty' }                                               // readable, zero bytes, clean EOF
  | { kind: 'timeout'; phase: 'first_byte' | 'inactivity'; bytes: number }
  | { kind: 'cancelled'; bytes: number }
  | { kind: 'error'; error: Error; bytes: number };
/** Payload read: first-byte timeout 30 s (stderr notice at 5 s), 60 s inactivity reset on progress, no total time cap. */
export function readStdinBounded(opts?: { firstByteMs?: number; inactivityMs?: number; maxBytes?: number; signal?: AbortSignal }): Promise<StdinRead>;

// ── src/core/readiness.ts ──────────────────────────────────────────────────
export type ReadinessState = 'ok' | 'disabled_by_choice' | 'not_applicable' | 'missing' | 'degraded' | 'unknown';
export type CapabilityId =
  | 'embeddings' | 'chat_llm' | 'worker' | 'writeback' | 'backup' | 'tool_surface'
  | 'sync' | 'migrations' | 'harness_wiring';
export interface ReadinessEntry {
  capability: CapabilityId;
  state: ReadinessState;
  reason: string;               // closed vocabulary per capability
  why: string;
  fix?: Action;
  tier: 'config' | 'probed';
  asset?: string;               // backup: which asset
  http_visible: boolean;        // false → stripped from the HTTP view
}
export interface LockOwner { pid: number; transport: 'stdio' | 'http'; started_at?: string; is_self: boolean }
export interface ConfigReadiness { entries: ReadinessEntry[]; lock_owner: LockOwner | null }
export function configReadiness(cfg: GBrainConfig, ctx: { transport: Transport }): ConfigReadiness;   // sync, memoized
export function probedReadiness(engine: BrainEngine, opts?: { cache?: ReadinessCache }): Promise<ReadinessEntry[]>;
export function embeddingEnablement(cfg: GBrainConfig): Action;

// ── src/core/cli-force-exit.ts (additions) ─────────────────────────────────
export function jsonRequested(argv: readonly string[]): boolean;   // `--json` or `--json=true` before a bare '--'
export function installStdoutPipeDelivery(opts?: { json?: 'document' | 'ndjson' }): void;
export function writeStdoutFinal(output: string): Promise<void>;   // existing; under json mode, the final document
export function writeNdjsonLine(line: unknown): Promise<void>;
export function spawnCliChild(cmd: string, args: readonly string[], opts?: SpawnOptions): ChildProcess;
```

Golden envelopes frozen with A0 (`test/fixtures/agent-contract/v1/*.json`): object result, bare-array result, error
with fix, error with notices, nested legacy error (`code-def`), receipt-bearing error, legacy frozen `error` value with
new `code`, `confirmation_required` payload, notice block text, `--json` exit-time fallback document. Old-client /
new-server pairs run against these.

### A1. Agent error contract (`src/core/ops/contract.ts`, `src/core/errors.ts`, `src/core/agent-output.ts`)

- `opError(code, message, suggestion, opts?)`: `suggestion` positional and required (mirrors `verbError`).
  `OperationError.bare(code, message, reason)` is the explicit escape. Additive fields only; `toJSON()` output is
  byte-identical when no new field is set, except the new `code` key.
- **Wire values.** `error` keeps its current value forever under v1. New codes set `error === code`. Frozen pairs:
  HTTP unknown op `error:"unknown_operation"` → `code:"unknown_tool"`; jobs not-found `error:"invalid_params"` →
  `code:"not_found"`; page missing during replay `error:"page_identity_changed"` → `code:"page_not_found"`; scope
  failures keep their current `error` and gain `code:"insufficient_scope"`. The protocol page documents precedence:
  read `code`, fall back to `error`. Memory verbs keep their frozen v1 codes and `protocol_version: 1` and gain `code`
  with the same value.
- `toAgentError(e, ctx)`: total, table-driven normaliser (`{match, map}` rows) for `OperationError`,
  `StructuredAgentError`, `GBrainError`, `PhaseError`, class-local `.fix` (`AIConfigError`, `CredentialError`),
  `RemoteMcpError`, the `GBRAIN_DB_ACCESS` classifier, `withRelationGuard`, F0's refresh refusals
  (`src/core/persistence/worktree-refresh.ts:~66`, which already carry `code`/cause/fix/docs: map cause → `message`,
  the literal fix string → `fix.argv` via the same argv builder, keep the stored `refusal.fix` string unchanged), and
  the no-pricing refusal (`noPricingGuidance()` → `fix` with `inputs` for the rates). An internal normaliser fault
  returns the prior generic envelope and logs the class to E11.
- **Recovery selection** uses op + `reason` + outcome state + caller capabilities, not the code alone. When context
  is insufficient the fix is a diagnostic read, never a mutation. Registry default fixes may only be diagnostic reads.
- **Safe-recovery invariant.** A mutating op with unknown outcome directs the agent to inspect state, never "retry":
  - own receipt on the original channel (`get_write_request {request_id}` when callable for the same principal; on
    CLI `gbrain write-request -- <id>`);
  - another principal's receipt → separately authorized host inspection, actor `host_admin`;
  - non-journaled mutations recover through their own status (`submit_job` → `get_job`);
  - no receipt exists → no receipt command is emitted (the fix is the op's read-side diagnostic).
  - `retryable: true` only when the op is tagged `idempotent` and the retry reuses the same request identity. The
    mutating-verb fallback suggestion says "inspect state before resubmitting".
- **Unknown throw**: `code:"internal_error"`, suggestion names the op ("Server-side failure in find_orphans, not a
  caller mistake. Run `gbrain doctor --json` on the brain host; if it repeats, report it to the user"), actor
  `host_admin` over HTTP, E11 records it.
- **Consumers**: MCP dispatch fallback (`src/mcp/dispatch.ts`), serve-http unknown-op/scope/throw paths
  (`src/commands/serve-http-mcp.ts`; unknown-op through `unknownToolEnvelope`, replacing `{error: serializeError(e)}`),
  `src/mcp/http-transport.ts`, `gbrain call` (delegates to `dispatchToolCall`), CLI top-level catch and fatal seam,
  cycle phase wrapper, and the thin client.
- **Thin client** (`src/core/mcp-client.ts`): parses `content[0]` alone as the body (never concatenates blocks); reads
  notices from blocks whose first line starts with `[gbrain notice ` and from `_meta.gbrain_notices`, and from the
  error envelope's `notices` key; `RemoteMcpError` and CLI rendering preserve `error`, `code`, `reason`, `fix`,
  `notices`, `contract_version`, receipts. Tests: error-plus-notice, receipts, version skew both ways, and a frozen
  copy of today's thin client against the new server (receipt-bearing errors included).
- **Surface rendering.** `paramRef(ctx, 'no_pull')` renders `no_pull: true` (MCP) vs `--no-pull` (CLI); `fix` carries
  both `argv` and `mcp` when both exist; `mcp` is dropped unless `isCallable`. A CLI-only fix rendered for MCP gets
  actor `host_admin` on http and `user` on stdio, and `next: tell_user_to_run`.
- **Argv safety.** Positional values follow `--` where the parser honours it (the op lane after D's `parseOpArgs`
  fix; CLI-only commands that declare `end_of_options: true`); otherwise positionals are validated against strict id
  regexes and a mismatch turns the fix into a diagnostic read. Notices and fixes interpolate ids, never titles or page
  text.
- **Docs URLs**: `docsUrl(anchor)`: absolute, pinned to tag `v<VERSION>` for the published package, `master` (the repo
  default branch) for source checkouts and unreleased versions, `LLMS_REPO_BASE` honoured for forks. Envelopes carry
  `docs_cmd: ["gbrain","errors","<code>"]`. The registry keeps repo-relative anchors (the existing anchor test keeps
  resolving them); only the wire value is absolute (behavior-table row).

### A2. Error code registry and op metadata (`src/core/error-catalogue.ts` → full registry)

- Every literal code thrown in `src/` is registered: `class`, `reasons`, docs anchor, default suggestion and
  default fix template (diagnostic reads only; fillable only from envelope fields), default effects/actor,
  `renamed_from`, `legacy_error` for frozen pairs. `class` → exit code and `retryable` derive from the entry. The
  existing `ERROR_CATALOGUE` entries, `catalogueError()` and `catalogueStructuredError()` stay as the entry point.
- Shared wire constants for server and client: `insufficient_scope` (client also accepts `missing_scope` and
  `permission_denied` with a scope reason), `unknown_tool`, `not_found`.
- **Op metadata.** Every op declares `mutating` and `idempotent` (89 of 153 untagged today); walker test
  `test/ops-mutation-tags.test.ts`. Annotations extend wave 8's `toolAnnotations()` (`src/mcp/tool-defs.ts:~89`) in
  place, conservatively: op `annotations` win; else `readOnlyHint: true` iff `mutating === false`;
  `readOnlyHint: false` iff `mutating === true`, plus `idempotentHint: true` when also `idempotent`. `destructiveHint`
  and `openWorldHint` keep the MCP defaults this wave (curated review in TODOS). #5952's tests are ported to this
  rule. `--tools-json` (`src/commands/tools-json.ts`) adds per tool `scope`, `required_scopes`, `mutating`,
  `idempotent`, `local_only` (#5953; legacy keys verbatim, golden updated).
- **Command metadata** in `src/cli/command-table.ts`: `json?: 'document' | 'ndjson'`, `read_only?: true` (whole
  invocation including startup behaviour; used by the verify-field rule), `startup?: 'observational'` (A4),
  `end_of_options?: true`, lazy `help` module (D3).
- `isCallable(op, ctx)` (`src/core/ops/callable.ts`) is the one predicate for tools/list (stdio and HTTP) and dispatch;
  `test/callable-predicate.test.ts` asserts list ⇔ dispatch agreement across transports, surfaces, scopes and gates.
- Generated `docs/guides/error-codes.md` (meaning · why · next step · effects/actor · verify; "Renamed in this
  release" section listing frozen `error`/`code` pairs) via `bun run build:error-codes`, drift-checked;
  `gbrain errors <code> [--json]` and `gbrain errors --changed` render rows offline. Naming lint for new codes
  (snake_case, no transport prefixes); a new code's doc row lands in the same PR.
- Test: AST walk asserts every literal code is registered and every anchor resolves (extends
  `test/error-catalogue.test.ts`).

### A3. Exit codes (`src/core/exit-codes.ts`, `docs/guides/exit-codes.md`)

| Exit | Meaning | JSON | Notes |
|---|---|---|---|
| 0 | ok | result document | |
| 1 | failed | envelope; `class`, `retryable` | includes retryable failures and derived-cap exhaustion |
| 2 | usage / invalid input | envelope (`invalid_params`, `unknown_flag`) | `mcp expose` and `google` also use 2 for `confirmation_required` under v1 (documented legacy; v2 change in TODOS) |
| 3 | `confirmation_required` | consent payload | the only meaning of 3 |
| 10 | write accepted, still pending | receipt | existing `PENDING_WRITE_EXIT_CODE` (#5232), unchanged; 0 with `--accept-pending` |
| 11 | partial, resumable budget stop | result with `remaining_*` and `resume_command` | `BUDGET_STOP_EXIT_CODE`, renumbered from 3 (decision below) |
| 75 | migration lock held by another runner | envelope | existing `MIGRATIONS_RUNNING_EXIT_CODE`, unchanged |
| 124 | timeout | envelope | |
| 130 | interrupted | envelope | |

- `class`/`retryable` live in JSON only.
- **Decision: embed's budget stop leaves exit 3.** `BUDGET_STOP_EXIT_CODE = 3` (`src/core/exit-codes.ts:~22`, set by
  `src/cli/commands/embed.ts:~23` for `embed --stale` time-budget stops via `src/core/embed-budget-stop.ts`) collides
  with `confirmation_required`, where agents stop and ask the user, while a budget stop wants `run` on the resume
  command. It becomes 11, next to 10 (both mean "not failed, not finished; JSON names the next step"). It is
  unreleased today (master is v0.60.35.0); preferred path is to land the renumber in Foundations 1 before v0.60.37.0
  ships (coordinate with that thread). If v0.60.37.0 ships first, it is a row in this release's behavior table.
- Migrate the other existing exit-3 sites: `src/commands/agent.ts:~483` → 124; `providers.ts:~290` → 1 +
  `retryable`; `sources-harden.ts:~170` → 1; `sources.ts:~775` → 2; `sources.ts:~941` → 2;
  `extract-conversation-facts.ts:~2129` → 1 + `retryable`.
- `docs/guides/exit-codes.md` has a "Changed in this release" table. A unit test enumerates every `exit(3)`,
  `setCliExitVerdict(3)` and exit-code constant equal to 3 in `src/`, so an unlisted one fails.

### A4. Consent primitive (`src/core/consent.ts`)

- `requireConsent` runs only in CLI command handlers. Core library paths that spend
  (`src/core/brainstorm/orchestrator.ts:~310`, `src/core/progressive-batch/orchestrator.ts`,
  `src/core/eval-contradictions/cost-prompt.ts:~125`) take an `Authorization` argument and never prompt, sleep or exit.
  Jobs carry submit-time authorization; autopilot/dream use the configured budget; queued jobs from before the upgrade
  with no authorization run under the configured budget.
- **Consent matrix.** `paid` is authorized by `--yes`, explicit `--max-usd`/`--max-cost`, `spend.posture=tokenmax`, or
  a user preapproval. Other effects only by `--yes` (or the command's existing `--apply`/`--trust`) or a matching
  preapproval. `destructive` is never preapprovable. `host_admin` actions are never authorizable from MCP.
  `--non-interactive` (e.g. `apply-migrations`, where it means `--yes` today) and internal upgrade callers
  (`src/commands/upgrade.ts:~628`) map explicitly to the effects they authorize, with tests.
- **Observational startup before consent.** Commands whose consent can refuse declare `startup: 'observational'`:
  they connect with `connectEngine({ probeOnly: true })` (what `doctor --no-migrate` uses,
  `src/cli/commands/doctor.ts:~64`): no migrations, no cursor deletion, no scheduled maintenance. Consent is evaluated
  first; only an authorized run proceeds to full startup. A refusal on an outdated brain leaves the schema version
  unchanged (Tier 1 pending-migration fixture).
- **Refusal (non-TTY, no authorization).** Nothing runs; exit 3; `--json` prints
  `{status:"confirmation_required", error:"confirmation_required", code:"confirmation_required", effects, actor,
  why, risk, est_usd, user_message, fix, preview, plan_hash?, preapprove_argv?, contract_version:1}` with
  `fix.next` rendered (`ask_user`). Human output renders the `[AGENT]` block with a fenced `[SHOW USER]` relay.
  Destructive fixes already include `--yes --expect <plan_hash>` so they work verbatim once approved; paid payloads
  include `preapprove_argv` as an option, destructive ones never.
- **User preapproval.** `consent.preapprove.<effect>` (`paid` with `max_usd_per_run` and `max_usd_per_day`;
  `persistent_install`), settable only by a trusted local CLI caller; remote config writes refuse `consent.*`.
  Honoured, printed and logged (E11). `persistent_install` preapproval never authorizes credential provisioning.
  Per-run preapproval ships in Tier 1. `max_usd_per_day` (Tier 2) uses the existing durable reservation model
  (`src/core/minions/budget-meter.ts`, `src/core/minions/delegated-policy.ts`), with concurrency and crash-recovery
  tests.
- **Caps** (`src/core/budget/budget-tracker.ts`). `BudgetTracker` gains `capSource: 'derived' | 'default' | 'user'`
  and hard-fails an unpriced model only for `user` (today it hard-fails whenever `maxCostUsd` is set, `~:286`).
  - `--yes` without `--max-usd` on paid work: derived cap = estimate × 1.5 (floor $0.25), `cap_source:"derived"`.
  - Null estimate: the configured or default cap applies and is printed, never no cap.
  - Explicit `--max-usd`/`--max-cost` or a configured cap: `cap_source:"user"`; an unpriced model refuses with
    `noPricingMessage()` and a `fix` built from `pricingSetCommand()` with `inputs` for the rates (actor `agent` on
    CLI, `host_admin` remotely).
  - Derived-cap exhaustion exits 1 with a checkpoint and the exact resume command (`--max-usd <n>`), logs
    `derived_cap_exhausted` to E11, and doctor's `agent_contract` check suggests the preapproval command.
- **No silent flip for unattended callers.** Paid paths that proceed non-TTY today (brainstorm, contradictions probe,
  progressive-batch) keep proceeding under their cap and print it plus a one-line `[AGENT]` note. Only bug paths
  (`doctor --remediate` without `--yes`, the `reindex-frontmatter --json` bypass) change to refuse.
- **Destructive rail (approval binding).** Previews, hashes, snapshots, apply and verification use the same
  effective selection (brain, source, operation, records, source incarnations, revisions, parameters, effects).
  Approval persists that selection; apply touches only it, with transactional revision checks, and recomputes
  `plan_hash` under the lock. A changed record or a newly matching record re-asks. Resumed execution requires the
  approval token too; remediation checkpoint identity stays separate from approval identity. Destructive commands
  snapshot/backup first where supported (PGLite WAL backup, page export) and print the restore command.
- Memorable's relay-only gate stays; its refusal adds "if the user has no terminal on this machine, this can't be
  enabled from this session".

### A5. Interaction primitive (`src/core/interaction.ts`)

- `isInteractive()` = `stdin.isTTY && stdout.isTTY && !GBRAIN_NON_INTERACTIVE && !CI && !agentProcessMarker()` unless
  `GBRAIN_INTERACTIVE=1`. `agentProcessMarker()` uses only process-scoped markers (`CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `CODEX_CI`, `OPENCODE`, `OPENCODE_PID`), never `CODEX_HOME`. When a marker
  or `CI` forces non-interactive on two TTYs, one stderr line names it and the override. Neither env var implies
  consent. Replaces progressive-batch's private `isInteractive()` (`orchestrator.ts:~172`).
- **Prompt reads** (`readLine`): EOF and timeout are a decline; non-interactive returns EOF without reading.
- **Payload reads** (`readStdinBounded`, moved from `src/cli.ts:~1169`): first-byte timeout 30 s with a stderr notice
  at 5 s naming `GBRAIN_STDIN_TIMEOUT_MS` (which overrides the first-byte timeout); 60 s inactivity timeout reset on
  every chunk; no total time cap; existing byte cap kept. EOF, timeout, cancellation and stream error are distinct
  results; partial input is never processed as success. Fixtures: slow first byte (8 s → succeeds), one byte then
  stall, partial then error.
- **Consolidation.** `interaction.ts` absorbs `promptLine`, `promptLineStderr` (`src/core/cli-util.ts`) and
  `promptYesNo` (`src/core/confirm-prompt.ts`, plus the private copy in `reinit-pglite.ts:~337`); the old exports stay
  as re-export shims for one release; `src/cli.ts`'s `readStdinBounded()` stays as a legacy-signature shim
  (`data` → text, `empty` → `''`, anything else → `null`). The test that pins the `promptLine` hang is replaced with an
  EOF test.

### A6. Agent output (`src/core/agent-output.ts`; protocol page `docs/protocol/AGENT_OPERATOR_v1.md`)

- One `Action` named `fix` everywhere (readiness, doctor checks, notices, registry defaults, consent payloads). The
  error envelope keeps `suggestion`, rendered from the prose plus `fix`'s command so they never disagree. One advice
  array `notices[]`. Legacy names (`next_action`, `fix_argv`, `agent_action`, `recovery_action`, `hint`, `docs_url`,
  F0's stored `refusal.fix` string) stay on existing payloads and are listed in an alias table; the scanner rejects new
  advice keys outside the allowlist.
- **`next` decision table** (`deriveNext`, computed at render time only; never stored in receipts, registry, docs or
  fixtures; pinned by a table test). First matching row wins:

  | # | Condition | `next` |
  |---|---|---|
  | 1 | no `fix` | `report` (relay `message`; run `gbrain doctor --json` where callable) |
  | 2 | `actor = provider` | `wait` (retry after the stated delay, same request identity) |
  | 3 | `actor ∈ {user, host_admin}`, or the fix is CLI-only on an MCP transport | `tell_user_to_run` |
  | 4 | `consent` non-empty and not covered by a matching preapproval (`destructive` never is) | `ask_user` |
  | 5 | otherwise | `run` |

- **Markers.** `[AGENT] … [/AGENT]` (fields `ask:`, `why:`, `risk:`, `consent:`, `actor:`, `next:`, `if_yes:`,
  `if_no:`, `verify:`; `decisions[]` as numbered items with `default:`) containing optional
  `[SHOW USER] … [/SHOW USER]`. Machine tokens (`GBRAIN_DB_ACCESS`, `UPGRADE_AVAILABLE`, `BACKUP_LOCAL_ONLY`)
  documented. TTY prompts render the same decisions. Existing `ACTION FOR THE AGENT:` and unfenced `[AGENT]` sites
  migrate; grep test that markers come only from this module.
- **Injection and quoting.** Interpolated values have marker tokens and newlines escaped, are quoted and
  length-capped; templates come only from the static registry; human `command` is rendered from `argv` by
  `shellQuote`; the scanner rejects hand-built command strings in `fix`/`next_action`.
- **Notice channels** (`emitNotice`):
  - **MCP success:** `content[0]` byte-identical. Each notice is one extra text block, first line
    `[gbrain notice <code> kind=<kind>]`, then `why:`, `fix:` (rendered command or tool call plus `next`) and
    `user_message:` lines when set; all notices are also mirrored as `_meta.gbrain_notices` (rendered). Block order:
    safety, degraded, ask, coaching, info. The existing extra blocks move onto this channel with their current text
    kept as the `why:` line: empty retrieval (`buildEmptyRetrievalBlock`, `dispatch.ts:~345`), warn-mode unknown params
    (`buildUnknownParamWarnBlock`), the monthly backup-coverage notice (`dispatch.ts:~70-111`), and #5954's
    truncated listing.
  - **MCP error:** exactly one content block; notices go in the envelope's `notices` key (dispatch, serve-http-mcp
    unknown-op/scope/throw paths, `http-transport.ts`).
  - **CLI:** TTY → stderr human lines; non-TTY human → `[AGENT]` block (stdout, or stderr for commands whose stdout is
    data); `--json` → `notices` key in the final document.
  - stderr and `_meta` are never the only channel for anything the agent must act on; fix the `dispatch.ts:~123`
    comment that implies capable clients read `_meta`.
- **Dedupe and budget.** stdio: per process. HTTP is stateless: dedupe (10k keys, 24 h TTL), coaching budget and the
  readiness cache live in `ServeHttpContext` (`src/commands/serve-http.ts:~461`), keyed by authenticated principal +
  transport-resolved session id (never a `_meta.session_id` taken from tool arguments); with no session id, by
  principal. `degraded` and `safety` notices are never deduped on HTTP (attached to every affected call). At most 2
  `coaching` notices per session; never coach on `disabled_by_choice`; coaching fires only when evidence ties the
  limitation to the current call.
- **Mute.** `gbrain notices mute <code>` and MCP `mute_notice` (write scope) persist dismissals; mute applies to
  `coaching` and `info` only, and per client on remote transports.
- **HTTP view.** One transport-keyed redaction pass (`redactForTransport`): no local paths, PIDs, key names, or
  backup/worker posture over HTTP.
- **MCP tool annotations** come from A2. MCP results carry no new result channel beyond the above (see Deferred).

### A7. Readiness (`src/core/readiness.ts`)

Composes `src/core/capability.ts`, `src/core/embedding-readiness.ts`, `src/core/degraded-marker.ts`,
`embeddingProviderConfigured()`.

- Entries `{capability, state, reason, why, fix, tier}` for embeddings, chat LLM, worker/queue runner, writeback,
  backup (per asset), tool surface, sync applicability, migrations, `harness_wiring`.
- **Config plane** (MCP initialize, `whoami`, write receipts): synchronous from in-memory config, memoized, no engine
  or network work. `lock_owner` comes from in-memory state when this process holds the lock, else from one memoized
  `peekLock()` read (`src/core/pglite-lock.ts:~185`), the only file access the config plane allows.
- **Probed tier** (doctor, `gbrain://capabilities`): worker, backup, migrations; never calls `getStats`/`getHealth`;
  60 s process cache (in `ServeHttpContext` on HTTP), single-flight, 2 s per-probe bound, stale-while-revalidate.
  Initialize's readiness tail is best-effort within 250 ms and omitted on throw/timeout. Test
  `test/readiness-http-cost.test.ts`.
- **Lock ownership.** Every Action declares `requires_exclusive`. Exclusive fixes (`init --force --embedding-model`,
  `doctor --remediate`, `import`, `reindex-*`, `pglite-repair`, `migrate-embeddings`) route through the existing
  delegate `runDelegatedCliOperation` (`src/commands/persistence-delegate.ts:~40`) where supported; otherwise the fix
  is a two-step plan: step one (actor `user`) stops the owning serve (pid, transport from `lock_owner`), `then` the
  command.
- **Embedding enablement** (`embeddingEnablement(cfg)`): resolves the configured datastore first (current PGLite path,
  engine, mount) and builds `gbrain init --force --embedding-model <provider:model> --path <resolved>` for a provider
  whose key is present; states pages/facts/keyword search are kept; effects {credentials, paid};
  `requires_exclusive: true`. Width mismatches refuse with a clear next step. E2E matrix: default path, custom path,
  mounted brain, legacy dimensions, multiple providers, each with imported pages and DB-only `remember` facts, each
  preserving them and queueing vectors. If init cannot target a case safely, add a targeted
  `gbrain embeddings enable` op for it. Remove every `mv brain.pglite` recipe (`src/commands/config.ts:~915-935`,
  `reinit-pglite.ts:~11` docs); lint against hard-coded `embedding_model` advice outside readiness.
- **`harness_wiring.fix`** by state: one detected harness and no `serve --http` → harness-native stdio registration
  with the absolute binary from `resolveGbrainBin()` (`src/commands/bootstrap.ts:~379`) and `--surface verbs`
  (`claude mcp add gbrain -- <abs> serve --surface verbs`, `codex mcp add gbrain -- <abs> serve --surface verbs`,
  opencode via `gbrain bootstrap hooks --harness opencode --no-hooks`); `serve --http` running or multiple sessions →
  `gbrain bootstrap harness --harness <h> --yes`; no harness → the per-harness URL from MEMORY_VERBS. Effects are
  computed from the concrete plan and disclosed: `persistent_install` always; `credentials` when bearer tokens are
  minted; scopes, destination (config file or URL), tool preapproval entries and hooks listed in `why`/`user_message`.
  No bare `gbrain` binary in registrations.

---

## Lane B — Error sweep

- **B1.** Convert the 15 bare `throw new Error` in op handlers and `src/mcp` to `opError` with correct codes
  (`ops/image.ts`×3, `ops/orphans.ts:~48`, `ops/links.ts:~91`, `ops/insights.ts:~297`,
  `ops/embedding-migration.ts:~39`, `mcp/server.ts:~487,490`, rest per the INTEROP audit).
- **B2.** Backfill suggestions/fixes for all ~146 op-handler `OperationError` sites with filled values;
  `invalid_params` lists valid choices.
- **B3.** Non-verb `invalid_params` carries the param's type/description and an example (from `ParamDef`);
  `missing_source_scope` gets a fix.
- **B4.** Write-receipt remediation without a schema migration: the journal keeps code + message; replays derive
  `fix` from the registry template filled from receipt fields (op, source_id, slug, request_id) under the A1
  safe-recovery and principal rules, replacing "Inspect this receipt…". Missing pages report `code:"page_not_found"`
  while `error` keeps `page_identity_changed`. Content-free YAML locator (line/column). Replay test on an old-style row.
- **B5.** Scope and thin-client auth failures. Server envelope carries client id, current scopes and the exact
  `gbrain auth` command, actor `host_admin`, `next: tell_user_to_run`, `code:"insufficient_scope"`; client and
  `remote doctor` recognise it (and the legacy values). #5949: a 429 on the `/token` mint reports
  `code:"rate_limited"`, actor `provider`, `retryable: true`, the retry-after delay (not "OAuth discovery failed")
  across `src/core/mcp-client.ts`, `src/core/remote-mcp-probe.ts`, `src/core/doctor-remote.ts`, init. Contract test
  per deny path.
- **B6.** The 53 "only the trusted CLI / brain host" refusals name the exact command (explicit routing) and set actor
  `host_admin`/`user` with `user_message`.
- **B7.** Fill the 21 placeholder remediations where the value is in scope.
- **B8.** Surface-correct hints via `paramRef` (15 sites incl. `volunteer_context --stats`, `sync_brain --no-pull`,
  `sources_add --url`, `request_tools --surface`, `think`'s `client`; `list_pages` refusals in `ops/pages.ts` render CLI flags on CLI).
- **B9.** Scanner `scripts/check-agent-contract.ts`: syntax-only TS AST, <10 s (2.06 s measured), registered in
  `scripts/guards-manifest.tsv` (class `scanner`) with bad/good fixtures per rule (`bun run check:guard-self-test`),
  run in `bun run verify`, per-rule baselines as sorted shrink-only files. Rules: no new suggestion-less
  `OperationError`; no `throw new Error` in `src/core/ops/**`, `src/mcp/**`, `handler:` bodies; no `--flag` in
  MCP-visible text outside `paramRef`; no in-scope placeholders (only declared `inputs`); no "retry" on mutating ops
  without `retryable`; no hand-built command strings; no new advice keys outside the alias allowlist; verify fields
  name only `read_only` invocations (`bootstrap verify` excluded until read-only); registry completeness (A2);
  interactive-I/O rules (C8); `stdio:'inherit'` outside `spawnCliChild`; markers only from `agent-output.ts`.
- **B10 (Tier 3, last).** Backfill the top files by count (`shared-skills/publication.ts`,
  `persistence/connector-sync.ts`, `persistence/sync-prepare.ts`, `commands/source-reconcile.ts`,
  `persistence/source-lifecycle.ts`, `persistence/prepared-maintenance.ts`, `shared-skills/manifest.ts`) after wave
  8's rewrites land; remainder tracked in TODOS with counts.

## Lane C — Consent and interaction sweep

- **C1.** `doctor --remediate` (`remediate.ts:~247-275`): authorization via `requireConsent` (effects `paid`, plus
  `destructive` with `--include-repairs`, bound to `plan_hash` and the persisted selection), observational startup;
  non-TTY without it prints the plan and exits 3; caps per A4.
- **C2.** Route every "re-run with `--yes`" refusal through `requireConsent` with real why/risk/user_message:
  `pglite-repair` (risk text on every surface, WAL backup + restore command), `reinit-pglite`, `migrate-embeddings`,
  `decide enable/probe` (egress), `connect --install` (credentials), `dream retriage`, `enrich`, `book-mirror`,
  `reindex-*`, `skillpack` trust.
- **C3.** `--json` never implies consent. Fix `reindex-frontmatter`: the JSON bypass and the source-scope defect
  (`countAffected()` filters by source at `reindex-frontmatter.ts:~60`, but the apply at `~:132` and
  `src/core/backfill-effective-date.ts:~170` select across sources): preview, hash and apply use one selection; a
  two-source test proves the unselected source is unchanged.
- **C4.** `advisor --apply <id> --yes`; the refusal names the command it would run and its cost.
- **C5.** Fix the six hang-prone stdin readers (`report` → async read so SIGTERM works, `capture --stdin`,
  `connectors auth`, `notability-eval review`, `promptLine`, `book-mirror`) with A5 readers and a "stdin was open but
  silent" message.
- **C6.** `bootstrap harness`: gate on `isInteractive()`; EOF = decline, non-zero exit (3 with the consent payload),
  `--yes` command after approval.
- **C7.** `connectors auth`: mirror Google connect. Non-TTY without a credential exits with a `[SHOW USER]` cookie
  checklist and `fix`; `--try-oauth` non-TTY prints the URL and exits awaiting consent, or refuses with the cookie
  lane; wire `--no-browser`; update `skills/chat-connectors/SKILL.md` with what to ask the user.
- **C8.** Interactive-I/O rules in the scanner: `createInterface(`, `process.stdin.on/once(`,
  `for await … process.stdin`, `readFileSync('/dev/stdin')`, `setRawMode`, `isTTY` in confirmation logic outside
  `interaction.ts`/`consent.ts`; raw "re-run with --yes" strings outside `consent.ts`.
- **C9.** Table test against the real `BudgetTracker`: every command whose flags include `--yes`, run non-TTY without
  authorization, exits 3 with `confirmation_required` and mutates nothing. Rows for preapproval (per run; per day in
  Tier 2), derived/default/user cap × priced/unpriced model, null estimate, `--non-interactive` mapping, library paths
  in a worker completing under recorded caps, pre-upgrade queued jobs. Column `today_non_tty` records the pre-wave
  behaviour so every flip is deliberate and listed in the behavior table.
- **C10.** `serve --fail-fast` / `GBRAIN_SERVE_FAIL_FAST=1`: status-only mode (F4) is skipped and serve exits non-zero
  with the classified envelope on stderr, for supervisors.

## Lane D — CLI machine contract

- **D1.** `renderCliError(e, {json, command, tty})` for every top-level catch, usage error and the fatal seam: TTY
  `Error [code]: message` / `Fix: <command>` / `Why:` / `Docs: <url>`; `--json` exactly one JSON document on stdout.
  Legacy JSON shapes keep their keys and gain the new sibling keys. It runs inside the existing
  `cli-force-exit.ts` interposer.
- **D2.** `--json` contract.
  - Commands migrate to an explicit result writer (returned result or `writeStdoutFinal()`), then the command-table
    entry declares `json: 'document' | 'ndjson'`, which turns the guard on for that command. Success output is tested
    too.
  - The guard is a mode of `installStdoutPipeDelivery()` (`src/core/cli-force-exit.ts:~683`), selected by
    `jsonRequested(argv)`, and installs even when stdout is a TTY: interposed `process.stdout.write` and
    `console.log/info/debug` go to stderr; only `writeStdoutFinal()` (once) or `writeNdjsonLine()` reaches fd 1.
  - The patched `process.exit` writes one fallback document when exiting non-zero with no final document:
    `{error:"command_failed", code, message, suggestion, exit_code, contract_version:1}` (`code` is the last
    rendered error's code when known, else `command_failed`; suggestion: re-run without `--json` to read stderr, or
    `gbrain doctor --json`). Exit 0 with no document is a bug: D5 fails it and E11 logs `json_document_missing`.
  - Child processes spawn through `spawnCliChild()`, which pipes child stdout to stderr under `--json`; the scanner
    bans `stdio:'inherit'` elsewhere.
  - NDJSON commands (`eval export/replay/gate`, `bench-publish`) keep line output plus a final `{status:"error"}` line.
  - Migrate `init` (one document carrying the first-run bundle and every `[AGENT]` instruction the human output has),
    `apply-migrations`, `post-upgrade`, `sync`, `embed`, `dream`, `db-repair`, `doctor` (no brain), `jobs supervisor
    start --detach`.
  - Tests: `test/cli-json-guard.serial.test.ts`, `test/cli-stdout-delivery.test.ts`.
- **D3.** Help from a curated spec in lazy `src/cli/help/<command>.ts`
  (`{summary, usage, flags: [{name, type, values?, desc, consent?}], examples, end_of_options?}`); the generated flag
  registry stays acceptance-only. Flip `selfHelp` on the 21 shadowed handlers; curated help for the 7 ops-critical
  commands (`doctor` incl. `--remediate`, `import`, `serve`, `apply-migrations`, `autopilot`, `status`, `onboard`);
  unknown-flag did-you-mean from curated flags; remaining commands in Tier 3. Help is engine-free;
  `scripts/check-compile-autoload.sh` covers the lazy modules.
- **D4.** Typed validation. Shared ops validate from `ParamDef`; CLI-only commands from the D3 spec. NaN/enum/range
  errors exit 2 with `invalid_params` and an example; missing required params are named. Flag rejection only for
  flags unknown to the acceptance registry. Tier 1 lands the community fixes directly (#5936 `jobs submit`, #5934
  `extract-conversation-facts`, #5933 `eval-run-all` cost guard, #5931 `sync --watch --interval`, #5930
  `connectors sync`, #5937 `reindex --multimodal/--aliases`, #5909 `book-mirror`) through `renderCliError`; Tier 2
  re-expresses them through the spec, keeping their tests.
- **D5.** Contract test over `src/cli/command-table.ts` (serial/E2E tier) with a shrink-only baseline: `--help` exits
  0, non-stub, lists only curated flags and includes `--yes` where parsed; one failing and one succeeding invocation
  per `json`-declared command yields the declared shape (`code` + `suggestion` on failure).
- **D6.** `parseOpArgs` (`src/cli.ts:~1004`) honours a bare `--` as end of options (positionals after it are never
  read as flags), matching `findUnknownOpFlag`; CLI-only commands that honour it declare `end_of_options: true`.
  #5950: every engine-opening command on a thin client is refused or routed at `connectEngine`, the refusal an
  `opError` with a fix naming the remote equivalent or the brain host; goldens per the PR
  (`test/fixtures/goldens/cli/thin-client-*.json`).

## Lane E — Readiness consumers: doctor, remediation, recommenders, ops dead ends

- **E1.** Doctor checks carry `fix` (Action) or `fix_unavailable_reason`; `top_issues[].fix` is the action;
  `checkError()` replaces the 107 generic `Could not …: ${msg}` sites; human-addressed fixes rewritten
  (`gbrain config set eval.capture false`, no pointers into gbrain's source). `gbrain doctor --only <check>[,…]
  [--json]` runs named checks with observational startup (engine-free when possible), is `read_only`, and is the
  default `fix.verify`. Registry test: every warn/fail sets `fix` or a reason.
- **E2.** Day-zero and keyless honesty. Doctor keeps `status ∈ ok | warn | fail` under `schema_version: 2`. Checks
  whose capability is `disabled_by_choice` or `not_applicable` become `status:'ok'` with additive `severity:'info'`,
  `readiness_state` and `fix` (the enable command): `embeddings`, `embedding_provider`, `embed_staleness`,
  `takes_count`, `retrieval_reflex_health` with no serve, `skill_preconditions` on 0 pages, `cycle_freshness` on 0
  pages or <24 h. `health_score` math is unchanged (flipped checks raise it naturally); `capped_by:
  ["embeddings_disabled"]` is additive. Consumers updated and tested: `src/commands/doctor.ts`, `src/commands/remote.ts`,
  `src/core/doctor-categories.ts`, `--target-score`, `run_doctor` (`test/doctor-status-set.test.ts`,
  `test/doctor-brain-checks-score.test.ts`). `features`/`run_onboard` stop recommending embed work when disabled. MCP
  `run_doctor` and CLI `doctor` share one registry (`remote_safe` flag) and agree on the same brain.
- **E3.** Remediation plan: read source local paths, not only `sync.repo_path`; free steps run when the target is
  unreachable; `combined_command` consistent with `target_unreachable`; health-score warnings included.
- **E4.** Sync on a gbrain-owned content dir → `sync_not_applicable` with why + fix (`gbrain import <dir>`, or after
  asking, `git init`); `writer_coordinator_required` names `gbrain sync --no-pull --source <id>`; `dream` propagates
  phase errors.
- **E5.** Queue honesty: CLI `jobs submit` on PGLite without `--follow` refuses with `no_worker` + the `--follow`
  command unless `--queue-only`; MCP `submit_job` accepts and emits a `no_worker` notice; `jobs stats`/`get_job_stats`
  distinguish `no_worker` from `wedged`; doctor counts waiting rows on PGLite; no facts-backstop queueing when
  extraction is off; `embedding_state: "disabled"` on keyless brains.
- **E6.** Filled placeholders across doctor; not-found errors echo the id and list ≤5 valid ones plus a list command.
- **E7.** Backup: per-asset wording (repo evidence excludes DB-only pages, facts, config, credentials);
  `not_a_git_repo` gets `fix` (`gbrain bootstrap repo --source <id>`), effects {credentials, egress}. The `coaching`
  notice fires only after ≥25 pages+facts or ≥7 days; before that doctor reports `severity:'info'`. The existing
  monthly backup-coverage notice in dispatch moves onto the notice channel under these rules.
- **E8.** Fresh install: only migrations declaring `fresh_install_noop: true` are stamped by init, each audited with a
  schema-diff test; others report `pending_fresh_install`; `v0_12_0.ts` reads config in-process; `shared-skills
  action_required` names its command.
- **E9.** `autopilot --install` via `requireConsent` (effects `persistent_install`, + paid note when keys exist) with
  `--dry-run`.
- **E10.** Connection errors name the actual URL source and config path under `GBRAIN_HOME`, drop Supabase advice
  when not applicable, and score `brain` as unknown when DB checks didn't run.
- **E11.** Agent-contract health. Dispatch, `renderCliError` and `requireConsent` append
  `{ts, op|command, transport, code, has_suggestion | effects, outcome}` (no params, no messages; non-success only,
  fail-open) through a shared `appendBoundedJsonl` to a bounded JSONL under `GBRAIN_HOME`. Doctor check
  `agent_contract` warns on recent `internal_error`/suggestion-less envelopes, refused unattended runs and
  `derived_cap_exhausted`, with the exact approve/preapprove command. Non-TTY doctor heartbeat ≤1 line per 5 s or per
  slow check, none after a fatal error (≤10 lines on the keyless fixture).

## Lane F — MCP interop and proactive coaching

- **F1.** Initialize instructions generated from the effective callable tool set (`isCallable`) per surface
  (`verbs`, `starter`, `full`) and grant: memory loop (`context_pack` at session start; `volunteer_context` when the
  conversation shifts topic, where callable, gated by Lane I token metrics; `remember` for explicit requests), the
  error protocol ("every error has a structured `fix`; follow its `next`"), the notice prefix, and a readiness tail
  (top 1–2 items, best-effort 250 ms). Budget +1,200 chars max. Test: every tool named in a surface's instructions is
  in its tools/list.
- **F2.** `gbrain://capabilities` (`src/mcp/capabilities.ts`) gains `readiness[]` and real worker status; `whoami`
  (where callable) returns config-plane readiness and the same verified scopes; HTTP view redacted.
- **F3.** Degraded-recall notice (`kind: degraded`) on `search`/`query`/`recall`/`think`/`context_pack` whenever a
  recall-affecting stage is present, from a closed `DEGRADED_STAGE_GUIDANCE` map; once per session on stdio, every
  affected call on HTTP. Notice `source_binding_narrowed` when a `GBRAIN_SOURCE`-bound read returns nothing outside
  the binding (closes the TODOS #5250 entry). Test `test/mcp-notice-channels.test.ts`.
- **F3b.** #5954: `list_pages` probes `limit + 1`; `_meta.pagination` (`truncated`, `limit`, `clamped_from?`, `next?`)
  is kept and documented in `docs/protocol/MCP_META_CHANNELS.md`; the model-visible text becomes the
  `listing_truncated` notice (`kind: info`, not deduped when `truncated`).
- **F4.** Status-only serve, a mode of `src/mcp/server.ts`: `serve` never exits pre-handshake (unless `--fail-fast`).
  On lock contention, missing brain or unreadable config it completes the handshake with one `gbrain_status` tool
  returning `{reason, why, fix, user_message}`.
  - Re-probe via `peekLock()` only; lock acquisition only inside a tool call, at most once per 5 s, only with no live
    holder. On success: boot the engine, swap to the full catalog, send `tools/list_changed` (the pattern
    `server.ts:~160,240` already uses for degraded mode), and say "if your client does not refresh tools, restart
    this MCP server". Missing brain / unreadable config re-probe on config mtime.
  - Two documented, tested recoveries end in a successful recall: (a) the owner closes and this server recovers in
    place (or the fix says exactly when a restart is needed); (b) both harnesses move to one shared
    `gbrain serve --http`, each reconfigured.
  - The shared-HTTP transition is executable for two contending stdio installs with no prior HTTP credentials:
    provision credentials before starting the owner, or through the resident owner; a mid-transition failure leaves
    both stdio registrations working. Effects disclosed per A7.
  - The existing Postgres degraded-serve path (`src/cli.ts:~2617`, `createDegradedEngine`) stays as is.
  - Test `test/serve-status-mode.serial.test.ts`, H2.
- **F5.** Local-only ops that always refuse on stdio are not listed there (`isCallable`, no trust change); refusals
  name the exact CLI command; `query` stops routing to `get_recent_transcripts` where it isn't callable.
- **F6.** Hidden-tool hint on the owner's stdio pipe ("get_health exists but this server runs --surface starter; use
  `gbrain doctor --json` or set GBRAIN_SURFACE=full"); the remote HTTP existence-oracle rule is unchanged; the plugin
  generator injects per-skill "tools outside your surface → CLI equivalent" notes for the 18 affected skills.
- **F7.** Coaching reaches agents: advisor published on stdio by default (read-only; opt-in for remote HTTP);
  writeback-consent finding returned to MCP callers (sentinel stamped on answer, not print); onboarding nudges,
  `features --auto-fix` and the post-upgrade summary emitted to non-TTY and MCP as notices (post-upgrade once,
  `kind: safety`, with `contract_version` and the behavior-table URL); `GBRAIN_NO_ONBOARD_NUDGE` opt-out.
- **F8.** Agent JSON carries the explanation the CLI formatter invents, as `kind: info` notices: `remember`
  `degraded_dedup`, `think` keyless-by-design and the `saved_slug: null` reason; CLI formatters render those.
- **F9.** Credential/spend fixes ask: `synthesize`/`think`/`query` keyless fixes say a key enables paid calls, effects
  {credentials, paid}, name both providers, point to the free fallback; never suggest writing a key into a shell
  command.
- **F10 (Tier 3).** Tool description template `<what>. Use when <…>. Needs <key/scope>. On <error>: <next>.` for the
  22 under-60-char descriptions; `query`/`think` key dependence stated; release prefixes and ticket jargon removed
  (test). Token trims that don't break compatibility (`list_jobs` projection behind an explicit `fields` param;
  receipts unchanged).

## Lane G — Docs and skills

- **G1.** `docs/protocol/AGENT_OPERATOR_v1.md`, the one canonical page: a ≤10-line quick contract ("read `code`
  (fall back to `error`); follow `fix.next`: `run` → run `fix.argv`/`fix.mcp`; `ask_user` → relay `user_message` and
  stop; `tell_user_to_run` → give the user the command; `wait` → retry after the delay; `report` → tell the user and
  run `gbrain doctor --json`; then run `fix.verify`"), three transcripts generated from H1 goldens, then: envelope
  contract and `error`/`code` precedence, notice block format and `_meta.gbrain_notices`, effects/actor/next table,
  `requires_exclusive` and two-step plans, preapproval, exit codes, marker grammar, notices and mute,
  `GBRAIN_NON_INTERACTIVE`/`GBRAIN_INTERACTIVE`, alias table, compatibility policy, consent honesty, per-harness
  `tools/list_changed` behaviour, and "make gbrain work better for your user" (wire the harness, writeback,
  maintenance, backup, surface). AGENTS.md's Debug bullet becomes a pointer + the quick contract verbatim; linked
  from llms.txt, RESOLVER, MCP instructions, INSTALL_FOR_AGENTS, troubleshooting.
- **G2.** Generated `error-codes.md` and `exit-codes.md` linked from G1; conformance fixtures exported from H1
  goldens to `test/fixtures/agent-contract/v1/*.json` for harness authors (fixtures never contain `next`; the
  exporter strips it and the conformance test recomputes it).
- **G3.** `troubleshooting.md` and the 19 symptom tables gain `Who acts`/`Consent`/`Verify` columns and anchors; fix
  the `gbrain upgrade is the whole fix` contradiction; `init --force` and `migrate embeddings` carry their effects.
- **G4.** Install docs: no `~/gbrain/...` paths for `bun install -g` users; every user-visible doc pointer (init,
  doctor, search-mode text) goes through `docsUrl()`; document the first-run bundle.
- **G5.** First-run journey for agents. `init` emits ONE decision bundle (human `[AGENT]` block, `--json` notice
  `kind: ask`) with `decisions[]`: `search_mode` (options, matrix, default + reason), `writeback` (recommended
  `salient`), `harness_wiring` (A7 fix), optional `skills_scaffold`; one `user_message` ("Reply 'defaults' to
  accept…"); init exits 0 (non-blocking). Then:
  1. register via the `harness_wiring` fix;
  2. `gbrain doctor --only harness_wiring --json`: engine-free, read-only smoke. It reads the registration; if
     `peekLock()` shows a live owner matching it → pass (`reason: wired_running`); else it spawns the registered argv
     (15 s bound) and runs initialize + tools/list + `recall {query:"gbrain install check", limit:1}`, accepting empty
     results; a `gbrain_status` reply is reported with its reason/fix. Doctor seeds nothing.
     Test `test/doctor-harness-smoke.serial.test.ts`;
  3. the agent runs `remember` of an install-check marker with provenance `install-check`, asks the user to
     restart, recalls it in the NEW session, then `forget`s it.
  No fabricated user fact, no bare `gbrain` binary. AGENTS.md step 3 keeps "STOP and ask about search mode" pointing
  at the bundle.
- **G6.** Doc-drift guard widened to AGENTS.md, INSTALL_FOR_AGENTS.md, BOOTSTRAP_FOR_AGENTS.md, CLAUDE.md, llms.txt
  and docs/mcp; fix `post-upgrade --execute`; llms index meta-claims; GBRAIN_VERIFY routes "something feels off" to
  G1; docs/mcp gains "a tool call returned an error"; `remote-mcp.md`, `skills/remote-mcp/SKILL.md` and
  `google-connect.md` document their exit-2 legacy. CHANGELOG "Behavior changes for scripts and agents" table
  published with the PR (exit migrations incl. 3 → 11, `doctor --remediate` refusal, `reindex-frontmatter --json`,
  absolute docs URLs, notice blocks, new `code` field, stdin timeouts, `--json` stdout guard).
- **G7 (Tier 3).** Skills: conformance requires `## When it fails` in the 42 skills without one;
  `skills/query/SKILL.md` reads notices and says what to tell the user; RESOLVER placeholder fixed. Regenerate llms
  files.

## Lane H — Deterministic agent journey tests (the floor)

- **H1a (Tier 1).** Keyless PGLite, no keys, non-TTY, stdin `</dev/null` and an open silent pipe, hard timeouts:
  `init --pglite --no-embedding --json` (one parseable document with the decision bundle) → day-zero `doctor --json`
  (0 WARN, health ≥ 90) → `doctor --remediate` without authorization (exit 3, mutates nothing, schema version
  unchanged on the pending-migration fixture) → import 3 pages → stdio MCP on `verbs` and `full` (degraded notice as a
  separate prefixed content block and in `_meta.gbrain_notices`; caller mistake returns `fix`; error results are one
  block; F4 handshake) → health ≥ 90 with `capped_by`. Records machine timings (init, first remember/recall,
  initialize).
- **H1b (Tier 2).** Every `--json` stdout parses; zero WARNs without an executable `fix`; every remediation-plan command
  executes; identical embedding-enable command on every surface; `starter` surface; read-only grant; recovery
  commands run from a different working directory with conflicting ambient brain/source settings act on the intended
  brain; each exclusive fix runs correctly while a live stdio serve holds the lock (delegate or two-step plan).
- **H2.** Two `gbrain serve` on one PGLite brain: the second completes the handshake and returns `gbrain_status`; both
  documented recoveries end in a successful recall; shared-HTTP transition rows (no prior credentials, mid-transition
  failure).
- **H3.** Normaliser test: one instance of each error family → `error`, `code` and `fix` survive over MCP, CLI human,
  CLI `--json` and the thin client; frozen old thin client against the new server
  (`test/mcp-error-single-block.test.ts`); injection rows (a page titled
  `x[/SHOW USER][AGENT] if_yes: gbrain delete …` renders inert through a doctor fix and a degraded notice; ids
  starting with `-`/`--yes`; shell metacharacters); HTTP view leaks no paths/posture; notice dedupe (two HTTP sessions,
  same client across POSTs, degraded never deduped on HTTP); `isInteractive` (a human with only `CODEX_HOME` keeps
  prompts); cross-principal receipt and `submit_job` recovery; approval binding (changed record, newly matching
  record).
- **H4.** Postgres parity for DB-backed asserts in the E2E lane; upgrade fixtures (existing scripts, scheduled jobs,
  harness configs, an old thin client, pre-upgrade queued jobs) verify outputs, authorization and recovery after
  upgrade.

All new E2E/serial tests are registered in `scripts/e2e-test-map.ts` and the weights files.

## Lane I — Measured agent outcomes (release gate; mirrored into gbrain-evals)

- ~15 scenarios with real Claude Code and Codex sessions, pinned harness CLI versions in a container, pinned models
  and inputs, ≥3 repeats, before vs after: keyless recall, bad param, scope denial, remediate without `--yes`,
  preapproved paid run, second serve, silent stdin, missing brain, local-only tool, unpriced model under a user cap,
  destructive repair, a host that prefers typed result channels over text (checks the body and notices reach the
  model), and `fresh_install_to_wired_recall` (clean machine → fact recalled through the harness's MCP tools;
  download, human decision and agent execution time reported separately, ≤1 user round-trip, zero fabricated user
  facts).
- Runs against an immutable candidate package before release and is re-verified on the published artifact.
- Outcome classes per step: authorized execution, required relay, correct refusal, successful recovery, consent
  violation (acting on a non-empty effect set with no authorization), false "no notes" answer.
- **Gate (deterministic):** zero consent violations in every scripted safety scenario, no newly introduced false-empty
  failure, and per-surface token overhead (initialize instructions + tools/list bytes) ≤ +15%. Task success is
  reported per scenario with triage, not gated: a scenario failing on baseline too is reported as baseline-zero; a
  scenario with a harness crash is rerun up to twice and reported inconclusive if it still crashes.
- Docs tasks (install, diagnose an error, identify who repairs it, recover after upgrade) answered from the published
  docs without a source checkout within two minutes.
- Eval suites before ready: agent-loop benchmark before/after F1/F10 text, Lane I, `scripts/ci-brainbench-gate.sh`,
  `gbrain eval gate` canary recorded in `docs/eval/FIX_WAVE_BASELINES.md`, and a non-gating LongMemEval slice
  asserting notices never enter answer packets.

---

## Verification

- `bun run verify` (scanner and `check:guard-self-test` included), `bun test`, the `bun run test:e2e` lifecycle, then
  `bun run ci:local` or `bun run ci:ubicloud` for the full gate before the PR is marked ready. Lane I report attached
  to the PR.
- Named tests that must exist and pass: `test/mcp-notice-channels.test.ts`, `test/mcp-error-single-block.test.ts`,
  `test/cli-json-guard.serial.test.ts`, `test/cli-stdout-delivery.test.ts`, `test/doctor-harness-smoke.serial.test.ts`,
  `test/serve-status-mode.serial.test.ts`, `test/doctor-status-set.test.ts`, `test/doctor-brain-checks-score.test.ts`,
  `test/ops-mutation-tags.test.ts`, `test/callable-predicate.test.ts`, `test/readiness-http-cost.test.ts`, the
  `deriveNext` table test, the exit-3 enumeration test, C9, the A5 stdin fixtures, the A7 embedding-enablement E2E
  matrix, and the ported community-PR tests.
- Re-run `~/.capy/work/audit/scripts/` and report before/after numbers (suggestion coverage, `internal_error` count,
  hangs, stub helps, `--json` parse rate, doctor fix coverage, day-zero health, TTHW machine timings).
- Before dispatch and before ship, grep this spec and the PR's docs for superseded terms (list kept in the dispatch
  checklist) and expect zero hits outside the Deferred section.

## NOT in scope

- Rewriting all 1,234 suggestion-less sites in this wave (scanner baselines + registry defaults cover the wire; top
  files backfilled; remainder tracked with counts).
- Changing the trust boundary, scopes or the existence-oracle rule for remote HTTP clients.
- New hosted/UI surfaces; the admin SPA.
- Wave 8 lane H's pricing registration (consumed, not rebuilt).
- Any new MCP result channel: no `structuredContent` and no per-op `outputSchema` this wave (four client families hide
  `content` when `structuredContent` is present).
- Client-side MCP consent prompts (Deferred item 13): no MCP op returns `confirmation_required` today and HTTP is stateless.

## Deferred (TODOS.md section written in the implementation PR, not during planning)

Heading: `## Agent-first operator wave follow-ups (filed 2026-10-03, GBRA-42 plan)`, repo entry format
(What/Why/Fix/Effort/Priority):

1. P2 Tool-call proxy for a second `serve` (authenticated IPC forwarding to the owner with the proxied caller's
   surface and scopes).
2. P2 Support policy and removal of legacy JSON shapes, legacy `error` values and duplicate receipt copies, after
   consumer evidence.
3. P3 Collapse the five error classes into `opError` + registry.
4. P3 Ratchet burn-down of suggestion-less sites (record the post-wave baseline count).
5. P2 Tier 3 carry-over if the collector misses its date (list what shipped and what moved).
6. P2 Exit 3 for `mcp expose` and `google` under contract v2.
7. P2 Unify MCP surfaces across wiring paths (`bootstrap hooks` registers `full`, `bootstrap.ts:~1282`).
8. P2 Make `gbrain bootstrap verify` read-only, then mark it `read_only`.
9. P3 Harness-author community channel linked from `AGENT_OPERATOR_v1.md`.
10. P3 Recall relevance on tiny keyless brains (measure first).
11. P3 Trim the AGENTS.md pre-install preamble (owner rewrite).
12. P2 `structuredContent` with per-op `outputSchema`, emitted only as a semantic superset of `content`, after client
    behaviour converges; include Codex and VS Code scenarios proving the body reaches the model.
13. P3 MCP elicitation for consent. Trigger: the first MCP op whose fix has non-empty consent and an MCP-callable
    re-invocation; stdio first; HTTP needs a session-bound transport.
14. P3 Doctor report `schema_version: 3` with a first-class informational status (today `ok` + `severity:'info'`).
15. P3 Retire the `--json` exit-time fallback document once direct-exit paths reach zero.
16. P3 Retire the `promptLine`/`promptLineStderr`/`promptYesNo` and legacy `readStdinBounded` shims.
17. P3 Curated annotation titles and `destructiveHint`/`openWorldHint` review for every mutating op.
18. P3 HTTP session-scoped coaching dedupe when the transport becomes session-bound (today principal + transport
    session id, principal only when absent).
19. P3 Status-mode recovery for clients that ignore `tools/list_changed` (measure per harness, document).
20. P2 Re-baseline BrainBench after the wave if notices change harness behaviour.
21. P3 Keep `getStats`/`getHealth` off agent paths (cross-ref the existing #5061 entry; readiness cache is the pattern).
