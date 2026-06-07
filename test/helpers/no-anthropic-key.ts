/**
 * Per-test isolation from the developer's real `~/.gbrain/config.json`.
 *
 * `hasAnthropicKey()` (src/core/ai/anthropic-key.ts) and the gateway resolve
 * the Anthropic key from BOTH the `ANTHROPIC_API_KEY` env var AND the gbrain
 * config file (via loadConfig). A test that only `delete`s the env var is NOT
 * hermetic: it passes in CI (no config file) but fails on a developer machine
 * with a configured brain, because loadConfig() still resolves the key.
 *
 * Both isolation styles below share ONE implementation:
 *   - `suppressAnthropicKey()` — setup/teardown primitive: deletes the env var,
 *     repoints GBRAIN_HOME at a fresh empty temp dir, returns a `restore()` to
 *     call in `finally` / `afterAll` (also removes the temp dir).
 *   - `withoutAnthropicKey(fn)` — wrapper sugar over the primitive for a single
 *     async call site; restores (and cleans up) even on throw.
 *
 * loadConfig() reads the file fresh on every call and honors GBRAIN_HOME at
 * call time, so per-call / per-suite isolation is sufficient — no module-level
 * key state survives.
 *
 * SCOPE: in-process tests only. It mutates process.env.GBRAIN_HOME; do NOT use
 * it around a child-process spawn (the child would inherit the temp
 * GBRAIN_HOME). Subprocess tests isolate via their own child env instead.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function suppressAnthropicKey(): () => void {
  const origKey = process.env.ANTHROPIC_API_KEY;
  const origHome = process.env.GBRAIN_HOME;
  const tmp = mkdtempSync(join(tmpdir(), 'gbrain-nokey-'));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GBRAIN_HOME = tmp;
  return () => {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origKey;
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
}

export async function withoutAnthropicKey<T>(fn: () => Promise<T>): Promise<T> {
  const restore = suppressAnthropicKey();
  try {
    return await fn();
  } finally {
    restore();
  }
}
