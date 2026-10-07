/**
 * pi-mcp.ts — the ONE writer for gbrain's entry in pi's user-level MCP config
 * (`<agent-dir>/mcp.json`, `{ "mcpServers": { "<name>": {…} } }`).
 *
 * pi's format matches Claude Code's mcpServers (verified against pi 1.0.4
 * docs/mcp.md): stdio `{command, args, env}` or HTTP `{url, headers}`;
 * `type` optional (stdio | http | streamable-http); header/env values may be
 * `${ENV}` or a whole-value `!command` (how a Keychain-held bearer stays out
 * of the file). Invalid entries are skipped by pi without breaking others,
 * but an unparseable FILE breaks every server, so this writer fails closed:
 * it never rewrites a file it cannot parse.
 *
 * Ownership: pi documents `description` as a first-class field (it lists the
 * server in the system prompt), so gbrain's entry carries PI_MCP_DESCRIPTION
 * and ownership is "description === PI_MCP_DESCRIPTION". A same-name entry
 * without it (hand-made, or written by another tool) is FOREIGN: never
 * replaced, never removed. Unrelated servers and top-level keys survive
 * untouched (JSON round-trip; pi's file carries no comments).
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { atomicWriteTextFile } from './atomic-write.ts';
import { piMcpConfigPath } from './host-specs.ts';
import { stdioServeArgv } from '../mcp-registration.ts';
import type { McpSurface } from '../../mcp/surface.ts';

export const PI_MCP_DESCRIPTION = 'gbrain personal knowledge brain (managed by `gbrain bootstrap hooks --harness pi`)';
export const PI_MCP_DEFAULT_NAME = 'gbrain';

export type PiMcpSpec =
  | { kind: 'stdio'; gbrainBin: string; sourceId?: string; gbrainHome?: string; surface?: McpSurface | null }
  | { kind: 'http'; url: string; /** Whole-value pi `!command` that prints the Authorization header value. */ authCommand?: string };

export function buildPiMcpEntry(spec: PiMcpSpec): Record<string, unknown> {
  if (spec.kind === 'http') {
    if (!/^https?:\/\//.test(spec.url)) throw new Error(`pi MCP url must be http(s); got: ${spec.url}`);
    return {
      url: spec.url,
      ...(spec.authCommand ? { headers: { Authorization: `!${spec.authCommand}` } } : {}),
      description: PI_MCP_DESCRIPTION,
    };
  }
  if (!isAbsolute(spec.gbrainBin)) throw new Error(`gbrainBin must be an absolute path; got: ${spec.gbrainBin}`);
  const [command, ...args] = stdioServeArgv(spec.gbrainBin, spec.surface);
  const env: Record<string, string> = {};
  if (spec.sourceId) env.GBRAIN_SOURCE = spec.sourceId;
  if (spec.gbrainHome) env.GBRAIN_HOME = spec.gbrainHome;
  return { command, args, ...(Object.keys(env).length ? { env } : {}), description: PI_MCP_DESCRIPTION };
}

type ReadResult =
  | { ok: true; exists: boolean; config: Record<string, unknown>; servers: Record<string, unknown> }
  | { ok: false; reason: 'unparseable' | 'symlink' | 'not_object'; note: string };

function readPiMcpConfig(path: string): ReadResult {
  if (!existsSync(path)) return { ok: true, exists: false, config: {}, servers: {} };
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, reason: 'symlink', note: `${path} is a symbolic link — gbrain does not write through it; edit the target by hand or replace the link.` };
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unparseable', note: `${path} does not parse as JSON — fix it (pi cannot read it either), then re-run.` };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, reason: 'not_object', note: `${path} is not a JSON object — fix it, then re-run.` };
  }
  const c = config as Record<string, unknown>;
  const s = c.mcpServers;
  if (s !== undefined && (!s || typeof s !== 'object' || Array.isArray(s))) {
    return { ok: false, reason: 'not_object', note: `${path}: "mcpServers" is not an object — fix it, then re-run.` };
  }
  return { ok: true, exists: true, config: c, servers: (s ?? {}) as Record<string, unknown> };
}

function isOwnedEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).description === PI_MCP_DESCRIPTION;
}

export interface PiMcpStatus {
  path: string;
  present: boolean;
  owned: boolean;
  kind: 'stdio' | 'http' | null;
  url?: string;
  command?: string;
  args?: string[];
  /** Set when the file itself cannot be read. */
  error?: string;
}

export function readPiMcpStatus(opts: { path?: string; name?: string } = {}): PiMcpStatus {
  const path = opts.path ?? piMcpConfigPath();
  const r = readPiMcpConfig(path);
  if (!r.ok) return { path, present: false, owned: false, kind: null, error: r.reason };
  const entry = r.servers[opts.name ?? PI_MCP_DEFAULT_NAME];
  if (!entry || typeof entry !== 'object') return { path, present: false, owned: false, kind: null };
  const e = entry as Record<string, unknown>;
  const kind = typeof e.url === 'string' ? 'http' : typeof e.command === 'string' ? 'stdio' : null;
  return {
    path, present: true, owned: isOwnedEntry(e), kind,
    ...(typeof e.url === 'string' ? { url: e.url } : {}),
    ...(typeof e.command === 'string' ? { command: e.command } : {}),
    ...(Array.isArray(e.args) && e.args.every((a) => typeof a === 'string') ? { args: e.args as string[] } : {}),
  };
}

export type WritePiMcpResult =
  | { ok: true; path: string; changed: boolean; replacedPrior: boolean; backupPath: string | null; notes: string[] }
  | { ok: false; path: string; reason: 'foreign_entry' | 'unparseable' | 'symlink' | 'not_object'; notes: string[] };

function backup(path: string): string {
  const b = `${path}.gbrain.bak`;
  copyFileSync(path, b);
  chmodSync(b, statSync(path).mode & 0o777);
  return b;
}

/** Install or refresh gbrain's entry; foreign same-name entries are refused. */
export function writePiMcpEntry(opts: { spec: PiMcpSpec; path?: string; name?: string }): WritePiMcpResult {
  const path = opts.path ?? piMcpConfigPath();
  const name = opts.name ?? PI_MCP_DEFAULT_NAME;
  const r = readPiMcpConfig(path);
  if (!r.ok) return { ok: false, path, reason: r.reason, notes: [r.note] };
  const prior = r.servers[name];
  if (prior !== undefined && !isOwnedEntry(prior)) {
    return {
      ok: false, path, reason: 'foreign_entry',
      notes: [`${path} already has a "${name}" MCP server that gbrain did not write — kept as is. Remove it (or pass --no-mcp) to let gbrain manage the entry.`],
    };
  }
  const entry = buildPiMcpEntry(opts.spec);
  if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(entry)) {
    return { ok: true, path, changed: false, replacedPrior: true, backupPath: null, notes: [] };
  }
  const next = { ...r.config, mcpServers: { ...r.servers, [name]: entry } };
  const backupPath = r.exists ? backup(path) : null;
  atomicWriteTextFile(path, `${JSON.stringify(next, null, 2)}\n`, { freshMode: 0o600 });
  return { ok: true, path, changed: true, replacedPrior: prior !== undefined, backupPath, notes: [] };
}

export interface RemovePiMcpResult {
  path: string;
  removed: boolean;
  notes: string[];
}

/** Remove gbrain's entry only when it is ours; everything else survives. */
export function removePiMcpEntry(opts: { path?: string; name?: string } = {}): RemovePiMcpResult {
  const path = opts.path ?? piMcpConfigPath();
  const name = opts.name ?? PI_MCP_DEFAULT_NAME;
  const r = readPiMcpConfig(path);
  if (!r.ok) return { path, removed: false, notes: [r.note] };
  const prior = r.servers[name];
  if (prior === undefined) return { path, removed: false, notes: [] };
  if (!isOwnedEntry(prior)) return { path, removed: false, notes: [`${path}: the "${name}" MCP server is not gbrain-managed — left untouched.`] };
  const servers = { ...r.servers };
  delete servers[name];
  backup(path);
  atomicWriteTextFile(path, `${JSON.stringify({ ...r.config, mcpServers: servers }, null, 2)}\n`);
  return { path, removed: true, notes: [] };
}
