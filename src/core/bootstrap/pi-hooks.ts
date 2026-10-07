/**
 * pi-hooks.ts — the pi lifecycle-hook carrier: render, write, inspect and
 * remove the gbrain-owned pi extension (`<agent-dir>/extensions/gbrain-hooks.ts`).
 *
 * pi has NO shell-hook config file; its lifecycle surface is a TypeScript
 * extension API (pi.on(event, handler)). So the "hook registration" is one
 * extension FILE rendered from templates/pi/gbrain-hooks.ts.template, which
 * maps pi events onto `gbrain hook <event> --harness pi` (event map + payload
 * shape documented in the template header and PI_SPEC_ID in host-specs).
 *
 * Ownership is the first-line marker `gbrain:pi-hooks-v1`: a file at our path
 * WITHOUT it (a hand-made bridge, another tool's file) is never overwritten or
 * deleted — the writer refuses with a note naming it.
 *
 * Rendered env: GBRAIN_HOOK_LANE=pi always (seat lane label; deliberately NOT
 * 'harness', which makes the hook yield to a Claude Code workspace install in
 * the cwd — those hooks never fire under pi), plus GBRAIN_SOURCE /
 * GBRAIN_HOME / GBRAIN_SEAT when the install pins them. The binary path is
 * absolute (pi inherits the user's PATH, but a GUI-launched pi may not).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { atomicWriteTextFile } from './atomic-write.ts';
import { piHooksExtensionPath } from './host-specs.ts';

// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import T_PI_HOOKS from '../../../templates/pi/gbrain-hooks.ts.template' with { type: 'file' };

export const PI_HOOKS_MARKER = 'gbrain:pi-hooks-v1';
export const PI_HOOK_LANE = 'pi';

const BIN_PLACEHOLDER = '"__GBRAIN_BIN__"';
const ENV_PLACEHOLDER = '{ "__GBRAIN_HOOK_ENV__": "" }';

export interface PiHookEnv {
  GBRAIN_SOURCE?: string;
  GBRAIN_HOME?: string;
  GBRAIN_SEAT?: string;
}

export function loadPiHooksTemplate(): string {
  return readFileSync(T_PI_HOOKS as unknown as string, 'utf8');
}

/** Render the extension source. Values are JSON-encoded, so a path or label
 * can never break out of its string literal. */
export function renderPiHooksExtension(opts: { gbrainBin: string; env?: PiHookEnv; template?: string }): string {
  const template = opts.template ?? loadPiHooksTemplate();
  if (template.split(BIN_PLACEHOLDER).length !== 2 || template.split(ENV_PLACEHOLDER).length !== 2) {
    throw new Error('pi hooks template is missing a placeholder (or has a duplicate)');
  }
  const env: Record<string, string> = { GBRAIN_HOOK_LANE: PI_HOOK_LANE };
  if (opts.env?.GBRAIN_SOURCE) env.GBRAIN_SOURCE = opts.env.GBRAIN_SOURCE;
  if (opts.env?.GBRAIN_HOME) env.GBRAIN_HOME = opts.env.GBRAIN_HOME;
  if (opts.env?.GBRAIN_SEAT) env.GBRAIN_SEAT = opts.env.GBRAIN_SEAT;
  return template.replace(BIN_PLACEHOLDER, JSON.stringify(opts.gbrainBin)).replace(ENV_PLACEHOLDER, JSON.stringify(env));
}

export interface PiHooksStatus {
  path: string;
  /** A file exists at the extension path. */
  present: boolean;
  /** …and carries the gbrain marker. */
  owned: boolean;
  /** Rendered binary + env of an owned file (null when unparseable). */
  gbrainBin: string | null;
  env: Record<string, string> | null;
}

/** Read back an installed extension — the status/doctor/verify probe. */
export function readPiHooksStatus(opts: { path?: string } = {}): PiHooksStatus {
  const path = opts.path ?? piHooksExtensionPath();
  if (!existsSync(path)) return { path, present: false, owned: false, gbrainBin: null, env: null };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, present: true, owned: false, gbrainBin: null, env: null };
  }
  const owned = isOwned(text);
  if (!owned) return { path, present: true, owned, gbrainBin: null, env: null };
  const bin = /^const GBRAIN_BIN: string = (".*");$/m.exec(text);
  const env = /^const HOOK_ENV: Record<string, string> = (\{.*\});$/m.exec(text);
  const parse = <T>(s: string | undefined): T | null => {
    if (s === undefined) return null;
    try { return JSON.parse(s) as T; } catch { return null; }
  };
  return { path, present: true, owned, gbrainBin: parse<string>(bin?.[1]), env: parse<Record<string, string>>(env?.[1]) };
}

function isOwned(text: string): boolean {
  return (text.split('\n', 1)[0] ?? '').includes(PI_HOOKS_MARKER);
}

export type WritePiHooksResult =
  | { ok: true; path: string; changed: boolean; replacedPrior: boolean; notes: string[] }
  | { ok: false; path: string; reason: 'foreign_file'; notes: string[] };

/**
 * Install (or refresh) the extension. Idempotent: identical content is not
 * rewritten. A foreign file at our path is refused, never clobbered.
 * `opts.path` is a TEST SEAM; production writes piHooksExtensionPath().
 */
export function writePiHooksExtension(opts: { gbrainBin: string; env?: PiHookEnv; path?: string }): WritePiHooksResult {
  const path = opts.path ?? piHooksExtensionPath();
  const next = renderPiHooksExtension(opts);
  let prior: string | null = null;
  if (existsSync(path)) {
    prior = readFileSync(path, 'utf8');
    if (!isOwned(prior)) {
      return {
        ok: false, path, reason: 'foreign_file',
        notes: [`${path} exists and is not gbrain-managed (no "${PI_HOOKS_MARKER}" marker on line 1) — move it aside (pi loads every file in that directory, so two bridges would fire every hook twice), then re-run.`],
      };
    }
    if (prior === next) return { ok: true, path, changed: false, replacedPrior: true, notes: [] };
  }
  atomicWriteTextFile(path, next, { freshMode: 0o644 });
  return {
    ok: true, path, changed: true, replacedPrior: prior !== null,
    notes: ['pi loads extensions at startup: restart running pi sessions (or run /reload) to pick up the hooks.'],
  };
}

export interface RemovePiHooksResult {
  path: string;
  removed: boolean;
  notes: string[];
}

/** Delete the extension only when it is ours. */
export function removePiHooksExtension(opts: { path?: string } = {}): RemovePiHooksResult {
  const path = opts.path ?? piHooksExtensionPath();
  const st = readPiHooksStatus({ path });
  if (!st.present) return { path, removed: false, notes: [] };
  if (!st.owned) return { path, removed: false, notes: [`${path} is not gbrain-managed — left untouched.`] };
  rmSync(path, { force: true });
  return { path, removed: true, notes: [] };
}
