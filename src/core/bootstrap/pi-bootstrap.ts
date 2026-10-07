/**
 * pi-bootstrap.ts — `gbrain bootstrap <hooks|status|verify|uninstall> --harness pi`.
 *
 * pi's wiring is USER-GLOBAL and workspace-free: one extension file
 * (pi-hooks.ts) and one `mcpServers` entry in `<agent-dir>/mcp.json`
 * (pi-mcp.ts). Nothing here stages, commits or scans a workspace, so the
 * dispatcher routes `--harness pi` here BEFORE workspace resolution (and the
 * $HOME workspace guard, which protects workspace writes this lane never
 * makes). Every write is ownership-guarded: a foreign extension file or a
 * foreign `gbrain` MCP entry is reported and left untouched.
 *
 *   hooks      install/refresh the extension + MCP entry
 *              [--gbrain-bin P] [--source ID] [--seat L | --no-seat]
 *              [--no-hooks] [--no-mcp] [--surface S]
 *              [--url U [--mcp-auth-command CMD]] [--json]
 *   status     report both carriers (read-only, exit 0)
 *   verify     the same report; exit 1 unless the extension is gbrain's, its
 *              binary is executable and a gbrain MCP entry exists
 *   uninstall  remove only gbrain-owned carriers
 */

import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveGbrainBin } from '../gbrain-bin.ts';
import { isRegistrationSurface } from '../mcp-registration.ts';
import { isValidSourceId } from '../source-id.ts';
import { normalizeSeatLabel } from '../context/seat.ts';
import { readPiHooksStatus, removePiHooksExtension, writePiHooksExtension, type PiHooksStatus } from './pi-hooks.ts';
import { readPiMcpStatus, removePiMcpEntry, writePiMcpEntry, type PiMcpSpec, type PiMcpStatus } from './pi-mcp.ts';

export const PI_BOOTSTRAP_SUBCOMMANDS = ['hooks', 'status', 'verify', 'uninstall'] as const;
export type PiBootstrapSubcommand = (typeof PI_BOOTSTRAP_SUBCOMMANDS)[number];

export function isPiBootstrapSubcommand(sub: string): sub is PiBootstrapSubcommand {
  return (PI_BOOTSTRAP_SUBCOMMANDS as readonly string[]).includes(sub);
}

/**
 * Whether `gbrain bootstrap <sub>` belongs to the pi lane: `--harness pi`, or
 * `hooks` with no `--harness` when the only detected agent is pi (pi sets
 * PI_CODING_AGENT=true in its process; a detected Claude Code / Codex /
 * opencode marker keeps the workspace lane's own auto-detect).
 */
export function routesToPiBootstrap(
  sub: string,
  harnessFlag: string | undefined,
  otherHarnessDetected: boolean,
  env: Record<string, string | undefined> = process.env,
): sub is PiBootstrapSubcommand {
  if (!isPiBootstrapSubcommand(sub)) return false;
  if (harnessFlag === 'pi') return true;
  return sub === 'hooks' && harnessFlag === undefined && !otherHarnessDetected && env.PI_CODING_AGENT === 'true';
}

export interface PiBootstrapDeps {
  /** Stdout/stderr seams (default console). */
  log?: (s: string) => void;
  err?: (s: string) => void;
  /** Binary resolution seam (default resolveGbrainBin). */
  resolveBin?: () => string | null;
  /** Carrier path seams; production uses the PI_CODING_AGENT_DIR-resolved defaults. */
  extensionPath?: string;
  mcpPath?: string;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

export interface PiWiringReport {
  harness: 'pi';
  hooks: PiHooksStatus & { binExecutable: boolean | null };
  mcp: PiMcpStatus;
  healthy: boolean;
  problems: string[];
}

function executable(p: string | null): boolean | null {
  if (!p) return null;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function piWiringReport(deps: PiBootstrapDeps = {}): PiWiringReport {
  const hooks = readPiHooksStatus({ ...(deps.extensionPath ? { path: deps.extensionPath } : {}) });
  const mcp = readPiMcpStatus({ ...(deps.mcpPath ? { path: deps.mcpPath } : {}) });
  const binExecutable = hooks.owned ? executable(hooks.gbrainBin) : null;
  const problems: string[] = [];
  if (!hooks.present) problems.push(`no pi hooks extension at ${hooks.path} — run \`gbrain bootstrap hooks --harness pi\``);
  else if (!hooks.owned) problems.push(`${hooks.path} is not gbrain-managed — move it aside and run \`gbrain bootstrap hooks --harness pi\``);
  else if (binExecutable !== true) problems.push(`the extension's gbrain binary (${hooks.gbrainBin ?? 'unparseable'}) is not executable — re-run \`gbrain bootstrap hooks --harness pi\``);
  if (mcp.error) problems.push(`${mcp.path} is unreadable (${mcp.error})`);
  else if (!mcp.present) problems.push(`no "gbrain" MCP server in ${mcp.path} — run \`gbrain bootstrap hooks --harness pi\` (or add one by hand)`);
  return { harness: 'pi', hooks: { ...hooks, binExecutable }, mcp, healthy: problems.length === 0, problems };
}

function printReport(r: PiWiringReport, log: (s: string) => void): void {
  const h = r.hooks;
  log(`gbrain ↔ pi wiring`);
  log(`  hooks extension: ${h.path} — ${!h.present ? 'absent' : h.owned ? `gbrain-managed (bin ${h.gbrainBin}${h.binExecutable ? '' : ', NOT executable'}${h.env?.GBRAIN_SOURCE ? `, source ${h.env.GBRAIN_SOURCE}` : ''})` : 'present, NOT gbrain-managed'}`);
  const m = r.mcp;
  const what = m.kind === 'http' ? `http ${m.url}` : m.kind === 'stdio' ? `stdio ${[m.command, ...(m.args ?? [])].join(' ')}` : 'unrecognized shape';
  log(`  MCP server "gbrain": ${m.path} — ${m.error ? `unreadable (${m.error})` : !m.present ? 'absent' : `${m.owned ? 'gbrain-managed' : 'hand-made (kept)'}, ${what}`}`);
  for (const p of r.problems) log(`  ! ${p}`);
  if (r.healthy) log('  ok — restart pi (or /reload) after changes; `/gbrain-hooks` inside pi shows each hook\'s last outcome.');
}

export async function runPiBootstrap(sub: PiBootstrapSubcommand, rest: string[], deps: PiBootstrapDeps = {}): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const json = rest.includes('--json');
  const extOpt = deps.extensionPath ? { path: deps.extensionPath } : {};
  const mcpOpt = deps.mcpPath ? { path: deps.mcpPath } : {};

  if (sub === 'status' || sub === 'verify') {
    const r = piWiringReport(deps);
    if (json) log(JSON.stringify(r, null, 2));
    else printReport(r, log);
    return sub === 'verify' && !r.healthy ? 1 : 0;
  }

  if (sub === 'uninstall') {
    const h = removePiHooksExtension(extOpt);
    const m = removePiMcpEntry(mcpOpt);
    const out = { harness: 'pi', hooks: h, mcp: m };
    if (json) log(JSON.stringify(out, null, 2));
    else {
      log(h.removed ? `removed ${h.path}` : `no gbrain-managed pi extension at ${h.path}`);
      log(m.removed ? `removed the "gbrain" MCP server from ${m.path}` : `no gbrain-managed "gbrain" MCP server in ${m.path}`);
      for (const n of [...h.notes, ...m.notes]) err(`note: ${n}`);
    }
    return 0;
  }

  // ── hooks (install / refresh; --repair is the same idempotent path) ──────
  const noHooks = rest.includes('--no-hooks');
  const noMcp = rest.includes('--no-mcp');
  const source = flagValue(rest, '--source');
  if (rest.includes('--source') && (!source || !isValidSourceId(source))) {
    err(`invalid --source '${source ?? ''}' — a source id is lowercase letters, digits and dashes`);
    return 2;
  }
  let seat: string | undefined;
  if (rest.includes('--seat')) {
    const label = normalizeSeatLabel(flagValue(rest, '--seat'));
    if (!label) {
      err(`invalid --seat '${flagValue(rest, '--seat') ?? ''}' — pass a short lowercase label`);
      return 2;
    }
    seat = label;
  }
  const surfaceArg = flagValue(rest, '--surface');
  if (rest.includes('--surface') && !isRegistrationSurface(surfaceArg)) {
    err(`unknown --surface '${surfaceArg ?? ''}' — pass --surface verbs, starter, or full`);
    return 2;
  }
  const url = flagValue(rest, '--url');
  const authCommand = flagValue(rest, '--mcp-auth-command');
  if (authCommand && !url) {
    err('--mcp-auth-command needs --url (it sets the HTTP Authorization header)');
    return 2;
  }
  const gbrainBin = flagValue(rest, '--gbrain-bin') ?? (deps.resolveBin ?? resolveGbrainBin)();
  if (!gbrainBin || !isAbsolute(gbrainBin)) {
    err('cannot resolve an absolute gbrain binary path — pass --gbrain-bin <abs path>');
    return 2;
  }

  let code = 0;
  const notes: string[] = [];
  const result: Record<string, unknown> = { harness: 'pi', gbrainBin };
  if (noHooks) {
    result.hooks = { skipped: true };
  } else {
    const w = writePiHooksExtension({
      gbrainBin,
      env: { ...(source ? { GBRAIN_SOURCE: source } : {}), ...(seat ? { GBRAIN_SEAT: seat } : {}) },
      ...extOpt,
    });
    result.hooks = w;
    notes.push(...w.notes);
    if (!w.ok) code = 1;
    else if (!json) log(w.changed ? `pi hooks extension written: ${w.path}` : `pi hooks extension already current: ${w.path}`);
  }
  if (noMcp) {
    result.mcp = { skipped: true };
  } else {
    const spec: PiMcpSpec = url
      ? { kind: 'http', url, ...(authCommand ? { authCommand } : {}) }
      : { kind: 'stdio', gbrainBin, ...(source ? { sourceId: source } : {}), ...(surfaceArg && isRegistrationSurface(surfaceArg) ? { surface: surfaceArg } : {}) };
    let m;
    try {
      m = writePiMcpEntry({ spec, ...mcpOpt });
    } catch (e) {
      err(`pi MCP entry not written: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    result.mcp = m;
    notes.push(...m.notes);
    // A foreign `gbrain` entry already provides MCP: kept, reported, not a failure.
    if (!m.ok && m.reason !== 'foreign_entry') code = 1;
    else if (m.ok && !json) log(m.changed ? `pi MCP server "gbrain" written: ${m.path}` : `pi MCP server "gbrain" already current: ${m.path}`);
  }
  if (json) log(JSON.stringify({ ...result, ok: code === 0 }, null, 2));
  else for (const n of notes) err(`note: ${n}`);
  return code;
}
