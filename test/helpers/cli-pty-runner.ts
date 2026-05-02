/**
 * cli-pty-runner.ts — generic real-PTY runner for CLI E2E tests.
 *
 * Ported from gstack's claude-pty-runner.ts (D14/C-prime in the v0.25.1
 * plan). Generalized to drive any CLI binary (gbrain, openclaw, claude)
 * — the gstack-specific plan-mode orchestrators (runPlanSkillObservation,
 * runPlanSkillCounting, invokeAndObserve, the per-skill Step-0 boundary
 * predicates) are dropped because they assume Claude Code's plan-mode
 * UI specifics that don't apply here.
 *
 * Architecture: pure Bun.spawn — no node-pty, no native modules. Bun
 * 1.3.10+ has built-in PTY support via the `terminal:` spawn option.
 *
 * What gbrain uses this for in v0.25.1:
 *   - test/e2e/skill-smoke-openclaw.test.ts: drive an openclaw session
 *     interactively after `gbrain skillpack install book-mirror`,
 *     verifying real numbered-menu routing.
 *   - Future: any CLI command that grows interactive prompts (e.g.,
 *     book-mirror's cost-estimate "Continue? [y/N]") becomes testable
 *     without a refactor.
 *
 * For non-interactive CLI tests (skillpack install/uninstall stdout
 * grep), use Bun.spawnSync directly — that's lighter and matches the
 * existing test/cli.test.ts pattern.
 */

import * as fs from 'fs';

// ── ANSI / TTY helpers ──────────────────────────────────────

/** Strip ANSI escapes for pattern-matching against visible text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\d;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78=>]/g, '');
}

/** Detect a numbered AskUserQuestion-shaped option list with cursor. */
export function isNumberedOptionListVisible(visible: string): boolean {
  // ❯ cursor + at least two numbered options 1-9.
  // The `[^0-9]2\.` pattern handles the case where stripAnsi removes
  // TTY cursor-positioning escapes that visually rendered as spaces,
  // collapsing `text 2.` to `text2.`.
  return /❯\s*1\./.test(visible) && /(^|[^0-9])2\./.test(visible);
}

/**
 * Parse a rendered numbered-option list out of the visible TTY text.
 *
 * Looks for lines like `❯ 1. label` (cursor) or `  2. label` (no cursor)
 * and returns them in order. Used by tests that need to ROUTE on a
 * specific option label without hard-coding positional indexes that
 * drift when option order changes.
 *
 * Reads only the LAST 4KB of visible text to avoid matching stale
 * option lists from earlier prompts.
 *
 * Returns [] when no list is rendered (or when the list isn't a
 * sequential 1.., 2.., ... block — to avoid matching `1. Read the
 * file` prose). Otherwise returns indices in ascending order.
 */
export function parseNumberedOptions(
  visible: string,
): Array<{ index: number; label: string }> {
  const tail = visible.length > 4096 ? visible.slice(-4096) : visible;
  // `\s*` after `.` (not `\s+`) because stripAnsi removes TTY cursor-
  // positioning escapes that render as spaces — `1. Option` may come
  // through as `1.Option`.
  const optionRe = /^[\s❯]*([1-9])\.\s*(\S.*?)\s*$/;
  const lines = tail.split('\n');

  // Anchor on the LAST `❯<spaces>1.` line. Box-layout AUQs render
  // cursor mid-line after dividers + headers + prompt text on the same
  // logical line — the unanchored pattern catches those.
  let cursorLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/❯\s*1\./.test(lines[i] ?? '')) {
      cursorLineIdx = i;
      break;
    }
  }
  // Fallback: if cursor isn't on option 1 (user pressed Down), find
  // the last `1.` line.
  if (cursorLineIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(?:\s*|\s*❯\s+)1\./.test(lines[i] ?? '')) {
        cursorLineIdx = i;
        break;
      }
    }
  }
  if (cursorLineIdx < 0) return [];

  const found: Array<{ index: number; label: string }> = [];
  const seenIndices = new Set<number>();

  // Cursor line: option 1 may be inline after box dividers + header.
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorInlineRe = /❯\s*([1-9])\.\s*(\S.*?)\s*$/;
  const inlineMatch = cursorInlineRe.exec(cursorLine);
  if (inlineMatch) {
    const idx = Number(inlineMatch[1]);
    const label = (inlineMatch[2] ?? '').trim();
    if (label.length > 0 && !seenIndices.has(idx)) {
      seenIndices.add(idx);
      found.push({ index: idx, label });
    }
  } else {
    const startMatch = optionRe.exec(cursorLine);
    if (startMatch) {
      const idx = Number(startMatch[1]);
      const label = (startMatch[2] ?? '').trim();
      if (label.length > 0 && !seenIndices.has(idx)) {
        seenIndices.add(idx);
        found.push({ index: idx, label });
      }
    }
  }

  // Subsequent lines: standard start-of-line option parsing.
  for (let i = cursorLineIdx + 1; i < lines.length; i++) {
    const m = optionRe.exec(lines[i] ?? '');
    if (!m) continue;
    const idx = Number(m[1]);
    const label = (m[2] ?? '').trim();
    if (seenIndices.has(idx)) continue;
    if (label.length === 0) continue;
    seenIndices.add(idx);
    found.push({ index: idx, label });
  }

  // Only return if we found a sequential 1.., 2.., ... block (at least
  // 2 consecutive options starting at 1). Otherwise it's prose noise.
  found.sort((a, b) => a.index - b.index);
  if (found.length < 2) return [];
  if (found[0]!.index !== 1) return [];
  for (let i = 1; i < found.length; i++) {
    if (found[i]!.index !== found[i - 1]!.index + 1) {
      return found.slice(0, i);
    }
  }
  return found;
}

/**
 * Stable signature for a parsed numbered-option list. Used by tests
 * to detect "is this AUQ the same as the last poll, or has the agent
 * advanced to a new one?"
 */
export function optionsSignature(
  opts: Array<{ index: number; label: string }>,
): string {
  return [...opts]
    .sort((a, b) => a.index - b.index)
    .map((o) => `${o.index}:${o.label}`)
    .join('|');
}

/** Detect a workspace-trust dialog (claude / openclaw render this on first
 * use of a new directory). */
export function isTrustDialogVisible(visible: string): boolean {
  return visible.includes('trust this folder');
}

// ── binary resolution ──────────────────────────────────────

/**
 * Resolve a CLI binary on PATH, with common fallback locations. Used
 * to find `claude`, `openclaw`, `gbrain`, etc. without forcing tests
 * to hard-code paths.
 */
export function resolveBinary(name: string, override?: string): string | null {
  if (override && fs.existsSync(override)) return override;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const which = (Bun as any).which?.(name);
  if (which) return which;
  const home = process.env.HOME ?? '';
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `${home}/.local/bin/${name}`,
    `${home}/.bun/bin/${name}`,
    `${home}/.npm-global/bin/${name}`,
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

// ── PTY session ────────────────────────────────────────────

export interface PtyOptions {
  /** Absolute path to the binary. If omitted, uses the first arg of
   *  `args` as a binary name and tries resolveBinary on it. */
  binary?: string;
  /** Command + args, OR (when binary is omitted) [binaryName, ...args]. */
  args: string[];
  /** Terminal size. Default 120x40. */
  cols?: number;
  rows?: number;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Env override on top of process.env. */
  env?: Record<string, string>;
  /** Total run timeout (ms). Default 240_000 (4 min). */
  timeoutMs?: number;
  /** Auto-handle the workspace-trust dialog by sending "1\r". Default
   *  true since most claude/openclaw test runs see it on fresh tempdirs. */
  autoTrust?: boolean;
}

export interface PtySession {
  /** Send raw bytes to PTY stdin. Newlines = `\r` in TTY world. */
  send(data: string): void;
  /** Send a key by name. */
  sendKey(key: 'Enter' | 'Up' | 'Down' | 'Esc' | 'Tab' | 'ShiftTab' | 'CtrlC'): void;
  /** Raw accumulated stdout (with ANSI). For forensics. */
  rawOutput(): string;
  /** ANSI-stripped session output for pattern matching. */
  visibleText(): string;
  /**
   * Mark the current buffer position. Subsequent waitForAny /
   * visibleSince calls only look at output AFTER this mark. Useful
   * for scoping assertions to "after I sent the command" — avoids
   * matching against boot-banner residue.
   */
  mark(): number;
  /** Visible text since the most recent (or specific) mark. */
  visibleSince(marker?: number): string;
  /**
   * Wait for any of the supplied patterns to appear. Resolves with
   * the first match. Throws on timeout (last 2KB of visible included
   * in the error for forensics). If `since` is supplied, only matches
   * text after that mark.
   */
  waitForAny(
    patterns: Array<RegExp | string>,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }>;
  /** Convenience: single-pattern wait. */
  waitFor(
    pattern: RegExp | string,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void>;
  /** Subprocess pid (for debug). */
  pid(): number | undefined;
  /** True if the underlying process has exited. */
  exited(): boolean;
  /** Exit code, if known. */
  exitCode(): number | null;
  /**
   * Send SIGINT, then SIGKILL after 1s. Always safe to call
   * multiple times. Awaits process exit before resolving.
   */
  close(): Promise<void>;
}

/**
 * launchPty — spawn a CLI binary in a real PTY and return a session.
 *
 * Caller is responsible for `await session.close()` to release the
 * subprocess + timers.
 */
export async function launchPty(opts: PtyOptions): Promise<PtySession> {
  const args = [...opts.args];
  let binary = opts.binary;
  if (!binary) {
    if (args.length === 0) {
      throw new Error(
        'launchPty: pass a `binary` option, or `args[0]` as the binary name.',
      );
    }
    const resolved = resolveBinary(args[0]!);
    if (!resolved) {
      throw new Error(
        `launchPty: could not resolve "${args[0]}" on PATH. Set the binary location explicitly via the \`binary\` option, or install it.`,
      );
    }
    binary = resolved;
    args.shift();
  }

  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const autoTrust = opts.autoTrust ?? true;

  let buffer = '';
  let exited = false;
  let exitCodeCaptured: number | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (Bun as any).spawn([binary, ...args], {
    terminal: {
      cols,
      rows,
      data(_t: unknown, chunk: Buffer) {
        buffer += chunk.toString('utf-8');
      },
    },
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  // Track exit so waitForAny can fail fast if the subprocess crashes.
  let exitedPromise: Promise<void> = Promise.resolve();
  if (proc.exited && typeof proc.exited.then === 'function') {
    exitedPromise = proc.exited
      .then((code: number | null) => {
        exitCodeCaptured = code;
        exited = true;
      })
      .catch(() => {
        exited = true;
      });
  }

  // Top-level wall-clock timeout. If a test forgets to close, this
  // kills the subprocess eventually so CI doesn't hang forever.
  const wallTimer = setTimeout(() => {
    try {
      proc.kill?.('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  // Auto-handle the workspace-trust dialog. Polls during boot;
  // idempotent (only fires while the phrase is on screen).
  let trustHandled = false;
  let trustWatcher: ReturnType<typeof setInterval> | null = null;
  let trustWatcherStop: ReturnType<typeof setTimeout> | null = null;
  if (autoTrust) {
    trustWatcher = setInterval(() => {
      if (trustHandled || exited) return;
      const visible = stripAnsi(buffer);
      if (isTrustDialogVisible(visible)) {
        trustHandled = true;
        try {
          proc.terminal?.write?.('1\r');
        } catch {
          /* ignore */
        }
      }
    }, 200);
    trustWatcherStop = setTimeout(() => {
      if (trustWatcher) clearInterval(trustWatcher);
    }, 15_000);
  }

  function send(data: string): void {
    if (exited) return;
    try {
      proc.terminal?.write?.(data);
    } catch {
      /* ignore */
    }
  }

  type Key = Parameters<PtySession['sendKey']>[0];
  function sendKey(key: Key): void {
    const map: Record<string, string> = {
      Enter: '\r',
      Up: '\x1b[A',
      Down: '\x1b[B',
      Esc: '\x1b',
      Tab: '\t',
      ShiftTab: '\x1b[Z',
      CtrlC: '\x03',
    };
    send(map[key] ?? '');
  }

  let lastMark = 0;
  function mark(): number {
    lastMark = buffer.length;
    return lastMark;
  }
  function visibleSince(marker?: number): string {
    const offset = marker ?? lastMark;
    return stripAnsi(buffer.slice(offset));
  }

  async function waitForAny(
    patterns: Array<RegExp | string>,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }> {
    const wTimeout = waitOpts?.timeoutMs ?? 60_000;
    const poll = waitOpts?.pollMs ?? 250;
    const since = waitOpts?.since;
    const start = Date.now();
    while (Date.now() - start < wTimeout) {
      if (exited) {
        throw new Error(
          `subprocess exited (code=${exitCodeCaptured}) before any pattern matched. ` +
            `Last visible:\n${stripAnsi(buffer).slice(-2000)}`,
        );
      }
      const visible =
        since !== undefined ? stripAnsi(buffer.slice(since)) : stripAnsi(buffer);
      for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i]!;
        const matchIdx =
          typeof p === 'string' ? visible.indexOf(p) : visible.search(p);
        if (matchIdx >= 0) {
          return { matched: p, index: matchIdx };
        }
      }
      await Bun.sleep(poll);
    }
    throw new Error(
      `Timed out after ${wTimeout}ms waiting for any of: ${patterns
        .map((p) => (typeof p === 'string' ? JSON.stringify(p) : p.source))
        .join(', ')}\nLast visible (since=${since ?? 'all'}):\n${
        since !== undefined
          ? stripAnsi(buffer.slice(since)).slice(-2000)
          : stripAnsi(buffer).slice(-2000)
      }`,
    );
  }

  async function waitFor(
    pattern: RegExp | string,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void> {
    await waitForAny([pattern], waitOpts);
  }

  async function close(): Promise<void> {
    clearTimeout(wallTimer);
    if (trustWatcherStop) clearTimeout(trustWatcherStop);
    if (trustWatcher) clearInterval(trustWatcher);
    if (exited) return;
    try {
      proc.kill?.('SIGINT');
    } catch {
      /* ignore */
    }
    await Promise.race([exitedPromise, Bun.sleep(2000)]);
    if (!exited) {
      try {
        proc.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      await Promise.race([exitedPromise, Bun.sleep(1000)]);
    }
  }

  return {
    send,
    sendKey,
    rawOutput: () => buffer,
    visibleText: () => stripAnsi(buffer),
    mark,
    visibleSince,
    waitForAny,
    waitFor,
    pid: () => proc.pid as number | undefined,
    exited: () => exited,
    exitCode: () => exitCodeCaptured,
    close,
  };
}
