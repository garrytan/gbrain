/**
 * harness-pi.ts — the pi host of `gbrain bootstrap harness` (peeled out of
 * harness.ts, which stays the orchestrator: mint-first rotation, write-ahead
 * receipt, smoke, revocation).
 *
 * pi's wiring is two files under its agent dir, both gbrain-owned by marker:
 * - `mcp.json` → one `mcpServers.<name>` HTTP entry with the bearer INLINE
 *   (pi-mcp.ts; forced 0600). A framework-spawned pi inherits no shell env and
 *   cannot answer a Keychain prompt, so the `!command` header the interactive
 *   lane (`bootstrap hooks --harness pi --mcp-auth-command`) uses would not
 *   resolve. Ownership [C8] = the managed description AND this receipt's url.
 * - `extensions/gbrain-hooks.ts` → the hooks extension (pi-hooks.ts; line-1
 *   marker), with the same binary/source/seat env as the Claude hooks.
 * Every function takes the config-dir lock [X11] the way opencode's lane does.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteTextFile } from './atomic-write.ts';
import type { HarnessTarget } from './format.ts';
import { acquireBootstrapLock } from './lock.ts';
import { piEntryKind, removePiMcpEntry, writePiMcpEntry } from './pi-mcp.ts';
import { PI_HOOKS_MARKER, removePiHooksExtension, writePiHooksExtension, type PiHookEnv } from './pi-hooks.ts';

export interface PiRollback {
  path: string;
  backupPath: string | null;
  replacedPrior: boolean;
  /** Exact text this run wrote — the restore-guard compares the live file against it. */
  writtenText: string;
}

interface Log {
  log: (line: string) => void;
  logError?: (line: string) => void;
}

async function withDirLock<T>(dir: string, heldDir: string | null, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lk = heldDir && resolve(dir) === resolve(heldDir) ? null : await acquireBootstrapLock(dir);
  try {
    return fn();
  } finally {
    lk?.release();
  }
}

/** Consent lines for the pi host (numbered by the caller's counter). */
export function piConsentLines(p: { name: string; piConfig: string; piHooksPath: string; hooks: boolean; next: () => number }): string[] {
  const lines = [
    `  ${p.next()}. pi (user-global): write the mcpServers.${p.name} HTTP entry with the bearer token INLINE into ` +
      `${p.piConfig} (0600) — a framework-spawned pi inherits no shell env or Keychain prompt, so a !command ` +
      'header would not resolve.',
  ];
  if (p.hooks) {
    lines.push(
      `  ${p.next()}. pi hooks: write gbrain's extension to ${p.piHooksPath} (context injection + session-transcript ` +
        'capture, secret-scanned; GBRAIN_HOOKS=0 disables it at runtime).',
    );
  }
  return lines;
}

/**
 * Wire one pi target. Returns the mcp rollback record (null for the hooks
 * target); throws with a message the caller redacts and records.
 */
export async function wirePiTarget(
  t: HarnessTarget,
  o: Log & { name: string; url: string; priorUrl: string | null; token: string; gbrainBin: string | null; env: PiHookEnv },
): Promise<PiRollback | null> {
  return withDirLock(dirname(t.path!), null, () => {
    if (t.kind === 'mcp') {
      // Rotation across a url change: an entry at the PRIOR receipt's url is ours too.
      const expectUrl = o.priorUrl && o.priorUrl !== o.url && piEntryKind(t.path!, o.name, o.priorUrl) === 'ours' ? o.priorUrl : o.url;
      const r = writePiMcpEntry({ path: t.path!, name: o.name, spec: { kind: 'http', url: o.url, bearer: o.token }, expectUrl });
      if (!r.ok) throw new Error(r.notes.join(' '));
      o.log(`pi wired: mcpServers.${o.name} HTTP entry with inline bearer header in ${t.path} (0600). Restart pi (or /reload).`);
      return { path: t.path!, backupPath: r.changed ? r.backupPath : null, replacedPrior: r.replacedPrior, writtenText: r.writtenText };
    }
    if (!o.gbrainBin) throw new Error('cannot resolve an absolute gbrain binary path — pass --gbrain-bin <abs path>');
    const r = writePiHooksExtension({ path: t.path!, gbrainBin: o.gbrainBin, env: o.env });
    if (!r.ok) throw new Error(r.notes.join(' '));
    o.log(`pi hooks wired: ${t.path} (restart pi or /reload; /gbrain-hooks inside pi shows each hook's last outcome).`);
    return null;
  });
}

/** Failed smoke: restore the previous pi config (restore-guarded). Returns the target's failure note. */
export async function rollbackPi(rb: PiRollback, o: Log & { name: string; url: string }): Promise<string> {
  let note = 'rolled back to the previous pi config after the failed smoke';
  await withDirLock(dirname(rb.path), null, () => {
    // The lock was released before the smoke, so a NEWER registration may have
    // replaced ours: only restore when the live file is exactly what we wrote.
    const current = existsSync(rb.path) ? readFileSync(rb.path, 'utf8') : '';
    if (current !== rb.writtenText) {
      note = "smoke failed; pi rollback SKIPPED — the config changed after this run wrote it; this run's fresh mint is still revoked";
      o.log(`${note}.`);
    } else if (rb.backupPath && existsSync(rb.backupPath)) {
      atomicWriteTextFile(rb.path, readFileSync(rb.backupPath, 'utf8'), { forceMode: 0o600 });
      try { rmSync(rb.backupPath, { force: true }); } catch { /* best-effort */ }
    } else if (!rb.replacedPrior) {
      removePiMcpEntry({ path: rb.path, name: o.name, url: o.url });
    }
  });
  return note;
}

/** Verified wiring: the backup carries the PREVIOUS inline bearer and has no further consumer. */
export function discardPiBackup(rb: PiRollback | null): void {
  if (!rb?.backupPath) return;
  try { rmSync(rb.backupPath, { force: true }); } catch { /* best-effort */ }
}

/** A prior-receipt pi target no longer planned [X3]: remove it only if it is ours at the prior url. */
export async function removeStalePiTarget(
  pt: HarnessTarget,
  o: Log & { priorUrl: string; piConfig: string; piHooksPath: string; heldDir: string },
): Promise<void> {
  const path = pt.path ?? (pt.kind === 'mcp' ? o.piConfig : o.piHooksPath);
  const removed = await withDirLock(dirname(path), o.heldDir, () =>
    pt.kind === 'mcp'
      ? removePiMcpEntry({ path, name: pt.name ?? 'gbrain', url: o.priorUrl }).removed
      : removePiHooksExtension({ path }).removed,
  );
  if (removed) o.log(`stale pi ${pt.kind === 'mcp' ? 'MCP entry' : 'hooks extension'} removed from ${path} (no longer planned).`);
}

/** `--remove`: the pi targets of this receipt, ownership-checked [C8]. Throws on an unreadable config. */
export async function removePiTarget(
  t: HarnessTarget,
  o: Log & { receiptUrl: string; piConfig: string; piHooksPath: string; heldDir: string },
): Promise<void> {
  const path = t.path ?? (t.kind === 'mcp' ? o.piConfig : o.piHooksPath);
  if (!existsSync(dirname(path))) {
    o.log(`no pi ${t.kind === 'mcp' ? 'MCP config' : 'extension'} at ${path} — counted as removed.`); // [F2]
    return;
  }
  await withDirLock(dirname(path), o.heldDir, () => {
    if (t.kind !== 'mcp') {
      const r = removePiHooksExtension({ path });
      for (const note of r.notes) o.log(note);
      o.log(r.removed ? `pi hooks extension removed (${path}).` : `no gbrain pi extension at ${path} — counted as removed.`);
      return;
    }
    const kind = existsSync(path) ? piEntryKind(path, t.name ?? 'gbrain', o.receiptUrl) : 'absent';
    if (kind === 'unreadable') throw new Error(`pi config unreadable: ${path} — fix it, then re-run`);
    if (kind === 'absent') o.log(`pi MCP entry '${t.name}' already gone — counted as removed.`);
    else if (kind === 'foreign') {
      o.log(`pi MCP entry '${t.name}' is not gbrain's or points at another serve — owned by another install; skipping, cleared from the receipt.`);
    } else {
      removePiMcpEntry({ path, name: t.name ?? 'gbrain', url: o.receiptUrl });
      o.log(`pi MCP entry removed from ${path}.`);
    }
  });
}

/**
 * The pi targets for the write-ahead receipt. pi's hooks ARE its extension (no
 * shell-hook config), and the extension runs context injection AND capture,
 * so --no-capture skips it rather than half-wiring it; registrar mode skips it
 * for the Claude split-brain reason (hooks talk to the LOCAL brain).
 */
export function planPiTargets(o: { name: string; piConfig: string; piHooksPath: string; hooks: boolean }): HarnessTarget[] {
  return [
    { host: 'pi', kind: 'mcp', state: 'pending', scope: 'user', path: o.piConfig, name: o.name, mechanism: 'json-entry' },
    ...(o.hooks ? [{ host: 'pi' as const, kind: 'hooks' as const, state: 'pending' as const, scope: 'user', path: o.piHooksPath, marker: PI_HOOKS_MARKER, mechanism: 'extension' }] : []),
  ];
}

/** Step 7c: wire every pi target; per-target confirm/fail are the caller's receipt writers. */
export async function wirePiTargets(
  targets: HarnessTarget[],
  o: Parameters<typeof wirePiTarget>[1] & { confirm: (t: HarnessTarget) => void; fail: (t: HarnessTarget, err: string) => void; redact: (msg: string) => string },
): Promise<PiRollback | null> {
  let rollback: PiRollback | null = null;
  for (const t of targets) {
    if (t.host !== 'pi') continue;
    try {
      rollback = (await wirePiTarget(t, o)) ?? rollback;
      o.confirm(t);
    } catch (e) {
      o.fail(t, o.redact(e instanceof Error ? e.message : String(e)));
    }
  }
  return rollback;
}

/** Failed smoke: roll pi back and record the note on its mcp target. Never throws. */
export async function rollbackPiTargets(
  rb: PiRollback | null,
  targets: HarnessTarget[],
  o: Log & { name: string; url: string; fail: (t: HarnessTarget, err: string) => void },
): Promise<void> {
  if (!rb) return;
  try {
    const note = await rollbackPi(rb, o);
    const pt = targets.find((t) => t.host === 'pi' && t.kind === 'mcp');
    if (pt) o.fail(pt, note);
  } catch (e) {
    o.logError?.(`pi rollback failed: ${e instanceof Error ? e.message : String(e)} — re-run to converge.`);
  }
}
