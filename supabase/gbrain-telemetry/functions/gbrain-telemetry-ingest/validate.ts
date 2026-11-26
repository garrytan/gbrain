// Field checks for gbrain-telemetry-ingest, kept free of imports and Deno APIs
// so gbrain's own tests import and exercise this file directly
// (test/gbrain-telemetry-backend.test.ts). The fixed lists below are a copy of
// src/core/telemetry/enums.json between the BEGIN and END markers; the
// same test fails when they differ.

// BEGIN ENUMS (copy of enums.json)
export const ENUMS: Record<string, string[]> = {
  "event_type": [
    "setup",
    "upgrade",
    "doctor",
    "daily_rollup",
    "consent"
  ],
  "os": [
    "linux",
    "darwin",
    "win32",
    "freebsd",
    "other"
  ],
  "arch": [
    "x64",
    "arm64",
    "other"
  ],
  "install_method": [
    "bun_global",
    "release_binary",
    "git_clone",
    "npm",
    "unknown"
  ],
  "deployment": [
    "local_pglite",
    "local_postgres",
    "self_hosted_http",
    "thin_client_hosted",
    "thin_client_self_hosted",
    "unknown"
  ],
  "source": [
    "live",
    "test",
    "ci",
    "eval",
    "capy",
    "other"
  ],
  "tier": [
    "anonymous",
    "community"
  ],
  "harness": [
    "claude_code",
    "codex",
    "openclaw",
    "hermes",
    "cursor",
    "opencode",
    "pi",
    "hosted",
    "other"
  ],
  "step": [
    "brain_create",
    "mcp_register",
    "hooks",
    "instructions",
    "wiring_smoke",
    "done"
  ],
  "outcome": [
    "success",
    "error",
    "abort"
  ],
  "embedding": [
    "none",
    "configured"
  ],
  "channel": [
    "stable",
    "latest",
    "tag",
    "unknown"
  ],
  "score_band": [
    "0-29",
    "30-49",
    "50-69",
    "70-89",
    "90-100"
  ],
  "mode": [
    "manual",
    "autopilot",
    "alert"
  ],
  "brain_size_band": [
    "0",
    "1-99",
    "100-999",
    "1k-9.9k",
    "10k+"
  ],
  "transport": [
    "stdio",
    "http",
    "none"
  ],
  "answer": [
    "anonymous",
    "community"
  ],
  "crash_class": [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "other"
  ]
};
// END ENUMS


export const MAX_BATCH = 100;
export const MAX_BYTES = 50_000;

const VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5}))?$/;
const IDENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const BUN_RE = /^[0-9]{1,3}\.[0-9]{1,3}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export type Row = Record<string, unknown>;

function pick(key: string, v: unknown): string | null {
  return typeof v === "string" && ENUMS[key].includes(v) ? v : null;
}
export function str(re: RegExp, v: unknown): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}
function int(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function hour(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (t > now + 3_600_000 || t < now - 30 * 86_400_000) return null;
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
// A real calendar day within the last 31 days (or tomorrow, for clock skew).
function day(v: unknown): string | null {
  if (typeof v !== "string" || !DAY_RE.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
  const now = Date.now();
  return t > now + 86_400_000 || t < now - 31 * 86_400_000 ? null : v;
}
// {identifier: count} with at most 200 keys; keys off the identifier shape and
// counts that aren't a non-negative integer are dropped, and one report's count
// for a key is capped at 10,000. crash_counts keys come from a fixed list.
function counts(v: unknown, keyOk: (k: string) => boolean): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 200) break;
    if (!keyOk(k)) continue;
    const ci = int(c, 0, Number.MAX_SAFE_INTEGER);
    if (ci === null) continue;
    out[k] = Math.min(ci, 10_000);
    n++;
  }
  return Object.keys(out).length ? out : null;
}

export function toRow(e: Row): Row | null {
  if (e.v !== 1) return null;
  const event_type = pick("event_type", e.event_type);
  const event_hour = hour(e.ts);
  const gbrain_version = str(VERSION_RE, e.gbrain_version);
  const tier = pick("tier", e.tier);
  if (!event_type || !event_hour || !gbrain_version || !tier) return null;
  const installation_id = tier === "community" ? str(UUID_RE, e.installation_id) : null;
  const failing = Array.isArray(e.failing_checks)
    ? e.failing_checks.filter((c): c is string => typeof c === "string" && IDENT_RE.test(c)).slice(0, 10)
    : null;
  const row: Row = {
    schema_version: 1,
    event_type,
    event_hour,
    gbrain_version,
    os: pick("os", e.os) ?? "other",
    arch: pick("arch", e.arch) ?? "other",
    bun_version: str(BUN_RE, e.bun_version),
    install_method: pick("install_method", e.install_method) ?? "unknown",
    deployment: pick("deployment", e.deployment) ?? "unknown",
    git_backed: bool(e.git_backed),
    source: pick("source", e.source) ?? "other",
    tier,
    installation_id,
    harness: pick("harness", e.harness),
    step: pick("step", e.step),
    outcome: pick("outcome", e.outcome),
    error_code: str(IDENT_RE, e.error_code),
    embedding: pick("embedding", e.embedding),
    duration_s: int(e.duration_s, 0, 86_400),
    from_version: str(VERSION_RE, e.from_version),
    to_version: str(VERSION_RE, e.to_version),
    channel: pick("channel", e.channel),
    migrations_applied: int(e.migrations_applied, 0, 999),
    failed_migration: int(e.failed_migration, 0, 99_999),
    wedged: bool(e.wedged),
    score_band: pick("score_band", e.score_band),
    failing_checks: failing && failing.length ? failing : null,
    mode: pick("mode", e.mode),
    brain_size_band: pick("brain_size_band", e.brain_size_band),
    rollup_day: day(e.rollup_day),
    transport: pick("transport", e.transport),
    command_counts: counts(e.command_counts, (k) => IDENT_RE.test(k)),
    operation_counts: counts(e.operation_counts, (k) => IDENT_RE.test(k)),
    error_code_counts: counts(e.error_code_counts, (k) => IDENT_RE.test(k)),
    crash_counts: counts(e.crash_counts, (k) => ENUMS.crash_class.includes(k)),
    answer: pick("answer", e.answer),
  };
  return row;
}

