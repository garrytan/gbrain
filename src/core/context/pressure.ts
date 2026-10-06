/**
 * Context-pressure warning: when a session's context window is about 80%
 * full, the next turn carries one notice telling the agent to save what
 * matters now with `remember` + `items`, before compaction drops it.
 *
 * On by default (opt-out `memory.pressure.enabled=false`). Gates come from
 * the serve (DB-plane config plus whether `remember` is callable on its
 * surface); the harness side measures fill and fires at most once per
 * compaction segment.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';

export const PRESSURE_CONFIG_KEYS = {
  enabled: 'memory.pressure.enabled',
  warnRatio: 'memory.pressure.warn_ratio',
  contextWindow: 'memory.pressure.context_window',
} as const;
export const PRESSURE_DEFAULT_WARN_RATIO = 0.8;
export const PRESSURE_DEFAULT_WINDOW = 200_000;
export const PRESSURE_LARGE_WINDOW = 1_000_000;
/** Tail read budget for the transcript scan (the newest assistant usage is near the end). */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Serve-sourced gate carried on the turn_context / context_pack response. */
export interface PressureGate {
  enabled: boolean;
  warn_ratio: number;
  context_window: number | null;
  remember_callable: boolean;
}

function parseBool(raw: string | null | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
  return null;
}

export function parseWarnRatio(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.5 && n <= 0.95 ? n : null;
}

export function parseContextWindow(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 8_000 && n <= 10_000_000 ? n : null;
}

/** Validation for `gbrain config set` on the pressure keys; null when valid. */
export function validatePressureConfigValue(key: string, value: string): string | null {
  if (key === PRESSURE_CONFIG_KEYS.enabled && parseBool(value) === null) return `${key} must be true or false (default true).`;
  if (key === PRESSURE_CONFIG_KEYS.warnRatio && parseWarnRatio(value) === null) return `${key} must be a number from 0.5 to 0.95 (default ${PRESSURE_DEFAULT_WARN_RATIO}).`;
  if (key === PRESSURE_CONFIG_KEYS.contextWindow && parseContextWindow(value) === null) return `${key} must be a whole number of tokens from 8000 to 10000000 (unset = detect).`;
  return null;
}

export async function readPressureGate(engine: Pick<BrainEngine, 'getConfig'>, rememberCallable: boolean): Promise<PressureGate> {
  const [enabled, ratio, window] = await Promise.all([
    engine.getConfig(PRESSURE_CONFIG_KEYS.enabled).catch(() => null),
    engine.getConfig(PRESSURE_CONFIG_KEYS.warnRatio).catch(() => null),
    engine.getConfig(PRESSURE_CONFIG_KEYS.contextWindow).catch(() => null),
  ]);
  return {
    enabled: parseBool(enabled) ?? true,
    warn_ratio: parseWarnRatio(ratio) ?? PRESSURE_DEFAULT_WARN_RATIO,
    context_window: parseContextWindow(window),
    remember_callable: rememberCallable,
  };
}

export interface TranscriptPressure {
  /** Tokens the newest assistant turn consumed (input + cache creation + cache read). */
  usedTokens: number;
  /** Model id of that turn, when recorded. */
  model: string | null;
  /** uuid of the newest compact boundary inside the scanned tail, if any. */
  boundary: string | null;
}

/** Parses the newest usage and compact boundary from Claude Code JSONL text (oldest → newest lines). */
export function scanTranscriptPressure(text: string): TranscriptPressure | null {
  const lines = text.split('\n');
  let usage: { used: number; model: string | null } | null = null;
  let boundary: string | null = null;
  for (let i = lines.length - 1; i >= 0 && (!usage || !boundary); i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!boundary && row.type === 'system' && row.subtype === 'compact_boundary' && typeof row.uuid === 'string') {
      boundary = row.uuid;
      if (!usage) return null; // nothing measured since the compaction: fill is unknown, so no warning
    }
    const msg = row.message as { usage?: Record<string, unknown>; model?: unknown; role?: unknown } | undefined;
    if (!usage && row.type === 'assistant' && msg?.usage && typeof msg.usage === 'object') {
      const n = (k: string) => (typeof msg.usage![k] === 'number' ? msg.usage![k] as number : 0);
      const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
      if (used > 0) usage = { used, model: typeof msg.model === 'string' ? msg.model : null };
    }
  }
  return usage ? { usedTokens: usage.used, model: usage.model, boundary } : null;
}

/** Reads the transcript tail and scans it; null when unreadable or unmeasured. */
export function readTranscriptPressure(path: string): TranscriptPressure | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // Drop the partial first line of a mid-file window.
    return scanTranscriptPressure(size > len ? text.slice(text.indexOf('\n') + 1) : text);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* noop */ }
  }
}

/**
 * Context window for the session: explicit config wins; then a 1M marker on
 * the model id or the configured model; then an observed fill above the
 * default window (only a large window could hold it); else the default.
 */
export function resolveContextWindow(opts: { configured: number | null; model: string | null; configuredModel?: string | null; maxSeen: number }): number {
  if (opts.configured) return opts.configured;
  const marker = /\[1m\]|-1m\b|1m-context/i;
  if ((opts.model && marker.test(opts.model)) || (opts.configuredModel && marker.test(opts.configuredModel))) return PRESSURE_LARGE_WINDOW;
  return opts.maxSeen > PRESSURE_DEFAULT_WINDOW ? PRESSURE_LARGE_WINDOW : PRESSURE_DEFAULT_WINDOW;
}

export function pressureNotice(percent: number): string {
  return `[gbrain] This conversation's context is about ${percent}% full and will be compacted soon; details that exist only in this conversation will be lost. ` +
    'Before continuing, call remember once with items: [...] (up to 20 facts, each with a short provenance) for decisions, preferences, commitments and open threads worth keeping. ' +
    'Skip anything already saved, secrets, and anything the user asked not to keep. This notice appears once per compaction.';
}

interface PressureState { segment: string; warned: boolean; maxSeen: number; lastUsed: number }

function stateFile(dir: string, sessionKey: string): string {
  // gbrain-allow-ascii-class: filesystem-safe filename fragment, not a displayed slug
  return join(dir, `${sessionKey.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'session'}.json`);
}

function readState(path: string): PressureState | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<PressureState>;
    return typeof s.segment === 'string' ? { segment: s.segment, warned: s.warned === true, maxSeen: Number(s.maxSeen) || 0, lastUsed: Number(s.lastUsed) || 0 } : null;
  } catch { return null; }
}

function writeState(path: string, dir: string, state: PressureState): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* best-effort: a lost state file can only re-fire one notice */ }
}

/** Fill at which harnesses compact automatically (Claude Code compacts a little before the window is full). */
export const AUTO_COMPACT_RATIO = 0.92;
/** Turns of headroom the notice leaves: warn when this many more turns like the last one would reach the compaction point. */
export const HEADROOM_TURNS = 2;

/**
 * Warn at `warnRatio` fill, or earlier when the context grows fast: when
 * HEADROOM_TURNS more turns of the size just seen would reach the automatic
 * compaction point, the next turn may already be compacted.
 */
export function shouldWarn(o: { used: number; window: number; warnRatio: number; growth: number }): boolean {
  if (o.window <= 0) return false;
  if (o.used / o.window >= o.warnRatio) return true;
  return o.growth > 0 && (o.used + HEADROOM_TURNS * o.growth) / o.window >= AUTO_COMPACT_RATIO;
}

export interface PressureDecision { notice: string | null; percent: number; window: number; reason?: string }

/**
 * Decides whether this turn carries the notice. `segmentHint` is the newest
 * compact boundary seen (null = none in view: the stored segment continues).
 * Records state only when it changes. Pure apart from the state file.
 */
export function decidePressure(input: {
  gate: PressureGate | null | undefined;
  sessionKey: string;
  stateDir: string;
  usedTokens: number;
  model: string | null;
  boundary: string | null;
  configuredModel?: string | null;
  /** Kept for the OpenClaw lane, which knows its window exactly. */
  windowOverride?: number;
}): PressureDecision {
  const gate = input.gate;
  if (!gate) return { notice: null, percent: 0, window: 0, reason: 'no_gate' };
  if (!gate.enabled) return { notice: null, percent: 0, window: 0, reason: 'disabled' };
  if (!gate.remember_callable) return { notice: null, percent: 0, window: 0, reason: 'remember_unavailable' };
  const path = stateFile(input.stateDir, input.sessionKey);
  const prev = readState(path);
  const segment = input.boundary ?? prev?.segment ?? 'start';
  const sameSegment = prev?.segment === segment;
  const maxSeen = Math.max(input.usedTokens, prev?.maxSeen ?? 0);
  const window = input.windowOverride ?? resolveContextWindow({ configured: gate.context_window, model: input.model, configuredModel: input.configuredModel, maxSeen });
  const ratio = input.usedTokens / window;
  const percent = Math.min(99, Math.round(ratio * 100));
  const warned = sameSegment && prev?.warned === true;
  const growth = sameSegment && prev ? Math.max(0, input.usedTokens - prev.lastUsed) : 0;
  const fire = shouldWarn({ used: input.usedTokens, window, warnRatio: gate.warn_ratio, growth }) && !warned;
  const next: PressureState = { segment, warned: warned || fire, maxSeen, lastUsed: input.usedTokens };
  if (!prev || prev.segment !== next.segment || prev.warned !== next.warned || prev.maxSeen !== next.maxSeen || prev.lastUsed !== next.lastUsed) writeState(path, input.stateDir, next);
  if (warned) return { notice: null, percent, window, reason: 'already_warned' };
  return fire ? { notice: pressureNotice(percent), percent, window } : { notice: null, percent, window, reason: 'below_threshold' };
}

/** Claude Code user-prompt lane: measure the transcript and decide the notice for this turn. */
export function claudeCodePressure(gate: PressureGate | null | undefined, transcriptPath: string, sessionId: string | undefined, stateDir?: string): PressureDecision | null {
  if (!gate?.enabled || !gate.remember_callable || process.env.GBRAIN_PRESSURE === '0') return null;
  const measured = readTranscriptPressure(transcriptPath);
  if (!measured) return null;
  return decidePressure({
    gate, sessionKey: `claude-${sessionId ?? 'nosession'}`, stateDir: stateDir ?? join(resolveGbrainHome(), 'hooks', 'pressure'),
    usedTokens: measured.usedTokens, model: measured.model, boundary: measured.boundary,
    configuredModel: process.env.ANTHROPIC_MODEL ?? null,
  });
}
