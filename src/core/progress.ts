/**
 * Bulk-action progress reporter.
 *
 * Single source of truth for per-object progress on long-running binaries
 * (doctor, embed, sync, extract, etc.). Writes to stderr so stdout stays
 * clean for data / JSON output that agents parse.
 *
 * Modes:
 *   auto (default): isTTY ? human-\r : human-plain one-line-per-event
 *   human: force human rendering
 *   json: emit one JSON object per line (see schema below)
 *   quiet: no output
 *
 * JSON event schema (stable from v0.15.2, additive only):
 *   {"event":"start","phase":"<snake.dot.path>","total"?:N,"ts":"<iso>"}
 *   {"event":"tick","phase":"...","done":N,"total"?:N,"pct"?:F,"elapsed_ms":N,"eta_ms"?:N,"ts":"..."}
 *   {"event":"heartbeat","phase":"...","note":"<str>","elapsed_ms":N,"ts":"..."}
 *   {"event":"finish","phase":"...","done"?:N,"total"?:N,"elapsed_ms":N,"ts":"..."}
 *   {"event":"abort","phase":"...","reason":"<SIGINT|SIGTERM>","elapsed_ms":N,"ts":"..."}
 *
 * Rules:
 *   - phase uses snake_case dot-separated machine-stable names.
 *   - total/pct/eta_ms are omitted when total is unknown (no fake totals).
 *   - stdout is NEVER written to. Data output stays a separate concern.
 *
 * See docs/progress-events.md for the full reference.
 */

export type ProgressMode = 'auto' | 'human' | 'json' | 'quiet';

export interface ProgressOptions {
  mode?: ProgressMode;
  stream?: NodeJS.WritableStream; // default process.stderr
  minIntervalMs?: number; // default 1000
  minItems?: number; // default: max(10, Math.ceil((total||1000)/100))
}

export interface ProgressReporter {
  start(phase: string, total?: number): void;
  tick(n?: number, note?: string): void;
  heartbeat(note: string): void;
  finish(note?: string): void;
  child(phase: string, total?: number): ProgressReporter;
}

// ---------------------------------------------------------------------------
// Singleton signal coordinator
// ---------------------------------------------------------------------------
// Per Codex review #28/#29: one process-level SIGINT/SIGTERM handler, tracking
// every live reporter. Per-instance handlers would leak listeners and interfere
// with command-level handlers (e.g. shell-handler abort in jobs.ts).
//
// We never call process.exit() or swallow the signal — we just emit abort
// events for live phases, then remove ourselves so the user's own handlers
// (or the default Node behavior) run as usual.

interface LivePhase {
  reporter: PhaseState;
  abort: (reason: string) => void;
}

const liveReporters = new Set<LivePhase>();
let signalHandlerInstalled = false;

function installSignalHandler(): void {
  if (signalHandlerInstalled) return;
  signalHandlerInstalled = true;

  const onSignal = (reason: 'SIGINT' | 'SIGTERM') => {
    // Copy to array so abort() can mutate liveReporters during iteration.
    const snapshot = Array.from(liveReporters);
    for (const entry of snapshot) {
      try {
        entry.abort(reason);
      } catch {
        /* best-effort */
      }
    }
  };

  // once() so we don't block user handlers or double-fire.
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

function resolveMode(mode: ProgressMode, stream: NodeJS.WritableStream): 'human-tty' | 'human-plain' | 'json' | 'quiet' {
  if (mode === 'quiet') return 'quiet';
  if (mode === 'json') return 'json';
  const isTty = (stream as { isTTY?: boolean }).isTTY === true;
  if (mode === 'human') return isTty ? 'human-tty' : 'human-plain';
  // auto
  return isTty ? 'human-tty' : 'human-plain';
}

// ---------------------------------------------------------------------------
// Stream write with EPIPE defense (sync throw path AND 'error' event path).
// ---------------------------------------------------------------------------

const brokenStreams = new WeakSet<NodeJS.WritableStream>();

function safeWrite(stream: NodeJS.WritableStream, chunk: string): void {
  if (brokenStreams.has(stream)) return;
  try {
    stream.write(chunk, (err) => {
      if (err) brokenStreams.add(stream);
    });
  } catch {
    brokenStreams.add(stream);
  }
}

// Attach one 'error' listener per stream so async EPIPE marks it broken.
const errorListenersAttached = new WeakSet<NodeJS.WritableStream>();
function attachErrorListener(stream: NodeJS.WritableStream): void {
  if (errorListenersAttached.has(stream)) return;
  errorListenersAttached.add(stream);
  // 'error' on a raw tty/pipe is rare, but EPIPE can surface this way.
  (stream as NodeJS.EventEmitter).on?.('error', () => {
    brokenStreams.add(stream);
  });
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderHumanLine(phase: string, done: number | undefined, total: number | undefined, note: string | undefined): string {
  const parts: string[] = [`[${phase}]`];
  if (typeof done === 'number') {
    if (typeof total === 'number' && total > 0) {
      const pct = Math.floor((done / total) * 100);
      parts.push(`${done}/${total} (${pct}%)`);
    } else {
      parts.push(`${done}`);
    }
  }
  if (note) parts.push(note);
  return parts.join(' ');
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Phase state (per start/finish lifecycle of one reporter instance)
// ---------------------------------------------------------------------------

interface PhaseState {
  phase: string;
  total?: number;
  done: number;
  startedAt: number;
  lastEmitMs: number;
  lastDoneEmitted: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  live: LivePhase | null; // membership in liveReporters for signal cleanup
}

// ---------------------------------------------------------------------------
// Reporter factory
// ---------------------------------------------------------------------------

interface ReporterInternal extends ProgressReporter {
  _phasePath: string[]; // for child phase path composition
}

class Reporter implements ReporterInternal {
  _phasePath: string[];
  private stream: NodeJS.WritableStream;
  private renderMode: 'human-tty' | 'human-plain' | 'json' | 'quiet';
  private minIntervalMs: number;
  private minItemsOverride?: number;
  private state: PhaseState | null = null;

  constructor(parentPath: string[], opts: Required<Omit<ProgressOptions, 'stream' | 'minIntervalMs' | 'minItems'>> & {
    stream: NodeJS.WritableStream;
    minIntervalMs: number;
    minItems?: number;
  }) {
    this._phasePath = parentPath;
    this.stream = opts.stream;
    this.renderMode = resolveMode(opts.mode, opts.stream);
    this.minIntervalMs = opts.minIntervalMs;
    this.minItemsOverride = opts.minItems;
    if (this.renderMode !== 'quiet') {
      attachErrorListener(this.stream);
      installSignalHandler();
    }
  }

  private defaultMinItems(total?: number): number {
    if (this.minItemsOverride !== undefined) return this.minItemsOverride;
    const base = total && total > 0 ? total : 1000;
    return Math.max(10, Math.ceil(base / 100));
  }

  private emitJson(obj: Record<string, unknown>): void {
    safeWrite(this.stream, JSON.stringify(obj) + '\n');
  }

  private emitHumanLine(line: string): void {
    if (this.renderMode === 'human-tty') {
      // \r rewrite: clear-to-EOL then carriage-return-positioned line.
      safeWrite(this.stream, `\r\x1b[2K${line}`);
    } else {
      safeWrite(this.stream, line + '\n');
    }
  }

  private finalizeHumanLine(): void {
    // When a TTY phase ends, move to a new line so subsequent output doesn't overwrite.
    if (this.renderMode === 'human-tty') safeWrite(this.stream, '\n');
  }

  private phaseName(localPhase: string): string {
    return [...this._phasePath, localPhase].join('.');
  }

  start(localPhase: string, total?: number): void {
    // Auto-finish prior phase if caller forgot.
    if (this.state) this.finish();

    const phase = this.phaseName(localPhase);
    const now = Date.now();
    const s: PhaseState = {
      phase,
      total,
      done: 0,
      startedAt: now,
      lastEmitMs: now,
      lastDoneEmitted: 0,
      live: null,
    };
    this.state = s;

    // Register with signal coordinator.
    const live: LivePhase = {
      reporter: s,
      abort: (reason) => this.abortFromSignal(reason),
    };
    liveReporters.add(live);
    s.live = live;

    if (this.renderMode === 'quiet') return;

    if (this.renderMode === 'json') {
      const obj: Record<string, unknown> = { event: 'start', phase, ts: nowIso() };
      if (typeof total === 'number') obj.total = total;
      this.emitJson(obj);
    } else {
      this.emitHumanLine(renderHumanLine(phase, undefined, total, 'start'));
    }
  }

  tick(n: number = 1, note?: string): void {
    const s = this.state;
    if (!s) return;
    s.done += n;

    if (this.renderMode === 'quiet') return;

    const now = Date.now();
    const sinceEmit = now - s.lastEmitMs;
    const itemsSinceEmit = s.done - s.lastDoneEmitted;
    const minItems = this.defaultMinItems(s.total);
    const isFinalTick = s.total !== undefined && s.done >= s.total;

    // Emit if: time-gate passed, OR enough items since last emit, OR this is the final tick.
    const shouldEmit = sinceEmit >= this.minIntervalMs || itemsSinceEmit >= minItems || isFinalTick;
    if (!shouldEmit) return;

    s.lastEmitMs = now;
    s.lastDoneEmitted = s.done;

    const elapsedMs = now - s.startedAt;
    if (this.renderMode === 'json') {
      const obj: Record<string, unknown> = {
        event: 'tick',
        phase: s.phase,
        done: s.done,
        elapsed_ms: elapsedMs,
        ts: nowIso(),
      };
      if (typeof s.total === 'number' && s.total > 0) {
        obj.total = s.total;
        obj.pct = Math.round((s.done / s.total) * 1000) / 10; // one decimal
        if (s.done > 0) {
          const msPerItem = elapsedMs / s.done;
          const remaining = Math.max(0, s.total - s.done);
          obj.eta_ms = Math.round(msPerItem * remaining);
        }
      }
      if (note) obj.note = note;
      this.emitJson(obj);
    } else {
      this.emitHumanLine(renderHumanLine(s.phase, s.done, s.total, note));
    }
  }

  heartbeat(note: string): void {
    const s = this.state;
    if (!s) return;
    if (this.renderMode === 'quiet') return;

    const now = Date.now();
    const elapsedMs = now - s.startedAt;

    if (this.renderMode === 'json') {
      this.emitJson({
        event: 'heartbeat',
        phase: s.phase,
        note,
        elapsed_ms: elapsedMs,
        ts: nowIso(),
      });
    } else {
      this.emitHumanLine(renderHumanLine(s.phase, undefined, undefined, note));
    }
  }

  finish(note?: string): void {
    const s = this.state;
    if (!s) return;

    if (s.heartbeatTimer) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = undefined;
    }
    if (s.live) {
      liveReporters.delete(s.live);
      s.live = null;
    }

    if (this.renderMode !== 'quiet') {
      const elapsedMs = Date.now() - s.startedAt;
      if (this.renderMode === 'json') {
        const obj: Record<string, unknown> = {
          event: 'finish',
          phase: s.phase,
          elapsed_ms: elapsedMs,
          ts: nowIso(),
        };
        if (s.done > 0) obj.done = s.done;
        if (typeof s.total === 'number') obj.total = s.total;
        if (note) obj.note = note;
        this.emitJson(obj);
      } else {
        this.emitHumanLine(renderHumanLine(s.phase, s.done > 0 ? s.done : undefined, s.total, note ?? 'done'));
        this.finalizeHumanLine();
      }
    }

    this.state = null;
  }

  private abortFromSignal(reason: string): void {
    const s = this.state;
    if (!s) return;
    if (s.heartbeatTimer) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = undefined;
    }
    if (this.renderMode !== 'quiet') {
      const elapsedMs = Date.now() - s.startedAt;
      if (this.renderMode === 'json') {
        this.emitJson({
          event: 'abort',
          phase: s.phase,
          reason,
          elapsed_ms: elapsedMs,
          ts: nowIso(),
        });
      } else {
        this.emitHumanLine(renderHumanLine(s.phase, s.done > 0 ? s.done : undefined, s.total, `aborted (${reason})`));
        this.finalizeHumanLine();
      }
    }
    if (s.live) {
      liveReporters.delete(s.live);
      s.live = null;
    }
    this.state = null;
  }

  child(localPhase: string, _total?: number): ProgressReporter {
    // Children inherit mode, stream, rate settings. The child's prefix path
    // is the parent's currently-active FULL phase (if any) plus the local
    // child-name passed here, so child.start('file1') renders as
    // '<parent-phase>.<child-name>.file1'. If parent has no active phase,
    // fall back to parent's own prefix.
    const childPath = this.state
      ? [this.state.phase, localPhase]
      : [...this._phasePath, localPhase];
    const child = new Reporter(childPath, {
      mode: this.modeForChildren(),
      stream: this.stream,
      minIntervalMs: this.minIntervalMs,
      minItems: this.minItemsOverride,
    });
    return child;
  }

  /**
   * Expose a heartbeat timer to external callers. The reporter owns the timer
   * so we can guarantee cleanup on finish/abort. Caller uses the returned
   * stopper in a try/finally. Internal helper — the canonical user API is:
   *
   *   p.start('phase');
   *   const stop = startHeartbeat(p, 'still scanning…');
   *   try { await slowWork(); } finally { stop(); p.finish(); }
   */

  // modeForChildren preserves the fully-resolved mode (so a parent in 'json'
  // doesn't re-evaluate TTY for children — they inherit the explicit mode).
  private modeForChildren(): ProgressMode {
    switch (this.renderMode) {
      case 'human-tty':
      case 'human-plain':
        return 'human';
      case 'json':
        return 'json';
      case 'quiet':
        return 'quiet';
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createProgress(opts: ProgressOptions = {}): ProgressReporter {
  const stream = opts.stream ?? process.stderr;
  return new Reporter([], {
    mode: opts.mode ?? 'auto',
    stream,
    minIntervalMs: opts.minIntervalMs ?? 1000,
    minItems: opts.minItems,
  });
}

/**
 * Starts a 1000ms interval that fires p.heartbeat(note). Returns a stop
 * function to call in finally. Safe to stop twice.
 *
 * Use for single long-running queries where there's no iteration to tick.
 */
export function startHeartbeat(p: ProgressReporter, note: string, intervalMs = 1000): () => void {
  const timer = setInterval(() => {
    try {
      p.heartbeat(note);
    } catch {
      /* reporter may be finished; ignore */
    }
  }, intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

// Test-only hook so we can assert one signal handler across many reporters.
// Not part of the public API; used by test/progress.test.ts.
export function __liveReporterCountForTest(): number {
  return liveReporters.size;
}

export function __signalHandlerInstalledForTest(): boolean {
  return signalHandlerInstalled;
}
