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
  | {
      kind: 'http';
      url: string;
      /** Whole-value pi `!command` that prints the Authorization header value. */
      authCommand?: string;
      /**
       * Bearer token written INLINE (`bootstrap harness`: a framework-spawned
       * pi inherits no shell env and no Keychain prompt, the codex/opencode
       * posture). The file is then forced to 0600. Exclusive with authCommand.
       */
      bearer?: string;
    };

export function buildPiMcpEntry(spec: PiMcpSpec): Record<string, unknown> {
  if (spec.kind === 'http') {
    if (!/^https?:\/\//.test(spec.url)) throw new Error(`pi MCP url must be http(s); got: ${spec.url}`);
    if (spec.authCommand && spec.bearer) throw new Error('pi MCP entry: pass authCommand or bearer, not both');
    return {
      url: spec.url,
      ...(spec.authCommand ? { headers: { Authorization: `!${spec.authCommand}` } } : {}),
      ...(spec.bearer ? { headers: { Authorization: `Bearer ${spec.bearer}` } } : {}),
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

/**
 * gbrain's entry as the harness lane sees it [C8]: `ours` = gbrain-managed AND
 * pointing at `url`; `foreign` = a same-name entry that is hand-made, or
 * gbrain-managed but wired to a different serve (another install's).
 */
export function piEntryKind(path: string, name: string, url: string): 'absent' | 'ours' | 'foreign' | 'unreadable' {
  const r = readPiMcpConfig(path);
  if (!r.ok) return 'unreadable';
  const e = r.servers[name];
  if (e === undefined) return 'absent';
  return isOwnedEntry(e) && (e as Record<string, unknown>).url === url ? 'ours' : 'foreign';
}

/** The inline bearer of OUR entry at `url` (never a `!command`, never a foreign entry's). */
export function parsePiEntryBearer(path: string, name: string, url: string): string | null {
  const r = readPiMcpConfig(path);
  if (!r.ok) return null;
  const e = r.servers[name] as Record<string, unknown> | undefined;
  if (!e || !isOwnedEntry(e) || e.url !== url) return null;
  const h = e.headers as Record<string, unknown> | undefined;
  const v = h && typeof h.Authorization === 'string' ? h.Authorization : '';
  const m = /^Bearer (\S+)$/.exec(v);
  return m ? m[1]! : null;
}

export type WritePiMcpResult =
  | { ok: true; path: string; changed: boolean; replacedPrior: boolean; backupPath: string | null; notes: string[]; writtenText: string }
  | { ok: false; path: string; reason: 'foreign_entry' | 'unparseable' | 'symlink' | 'not_object'; notes: string[] };

function backup(path: string, forceMode?: number): string {
  const b = `${path}.gbrain.bak`;
  copyFileSync(path, b);
  chmodSync(b, forceMode ?? statSync(path).mode & 0o777);
  return b;
}

/** A file holding an inline bearer (now, or in the version being replaced) is 0600. */
function holdsInlineBearer(servers: Record<string, unknown>): boolean {
  return Object.values(servers).some((e) => {
    const h = e && typeof e === 'object' ? (e as Record<string, unknown>).headers : undefined;
    return !!h && typeof h === 'object' && Object.values(h as Record<string, unknown>).some((v) => typeof v === 'string' && v.startsWith('Bearer '));
  });
}

/** Install or refresh gbrain's entry; foreign same-name entries are refused. */
export function writePiMcpEntry(opts: {
  spec: PiMcpSpec;
  path?: string;
  name?: string;
  /** [C8] Harness lane: an owned entry wired to a DIFFERENT url is another install's — refuse. */
  expectUrl?: string;
}): WritePiMcpResult {
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
  if (opts.expectUrl !== undefined && prior !== undefined && (prior as Record<string, unknown>).url !== opts.expectUrl) {
    return {
      ok: false, path, reason: 'foreign_entry',
      notes: [`${path}: the gbrain-managed "${name}" MCP server points at ${String((prior as Record<string, unknown>).url ?? 'a stdio command')}, not ${opts.expectUrl} — another install's wiring; kept as is. Remove it first (\`gbrain bootstrap uninstall --harness pi\`), then re-run.`],
    };
  }
  const entry = buildPiMcpEntry(opts.spec);
  if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(entry)) {
    return { ok: true, path, changed: false, replacedPrior: true, backupPath: null, notes: [], writtenText: readFileSync(path, 'utf8') };
  }
  const servers = { ...r.servers, [name]: entry };
  const next = { ...r.config, mcpServers: servers };
  const secret = holdsInlineBearer(servers) || holdsInlineBearer(r.servers);
  const backupPath = r.exists ? backup(path, secret ? 0o600 : undefined) : null;
  const writtenText = `${JSON.stringify(next, null, 2)}\n`;
  atomicWriteTextFile(path, writtenText, secret ? { forceMode: 0o600 } : { freshMode: 0o600 });
  return { ok: true, path, changed: true, replacedPrior: prior !== undefined, backupPath, notes: [], writtenText };
}

export interface RemovePiMcpResult {
  path: string;
  removed: boolean;
  notes: string[];
}

/** Remove gbrain's entry only when it is ours; everything else survives. */
export function removePiMcpEntry(opts: { path?: string; name?: string; /** [C8] remove only when it points here. */ url?: string } = {}): RemovePiMcpResult {
  const path = opts.path ?? piMcpConfigPath();
  const name = opts.name ?? PI_MCP_DEFAULT_NAME;
  const r = readPiMcpConfig(path);
  if (!r.ok) return { path, removed: false, notes: [r.note] };
  const prior = r.servers[name];
  if (prior === undefined) return { path, removed: false, notes: [] };
  if (!isOwnedEntry(prior)) return { path, removed: false, notes: [`${path}: the "${name}" MCP server is not gbrain-managed — left untouched.`] };
  if (opts.url !== undefined && (prior as Record<string, unknown>).url !== opts.url) {
    return { path, removed: false, notes: [`${path}: the gbrain-managed "${name}" MCP server points at another serve — left untouched.`] };
  }
  const servers = { ...r.servers };
  delete servers[name];
  const secret = holdsInlineBearer(r.servers);
  backup(path, secret ? 0o600 : undefined);
  atomicWriteTextFile(path, `${JSON.stringify({ ...r.config, mcpServers: servers }, null, 2)}\n`, secret ? { forceMode: 0o600 } : {});
  return { path, removed: true, notes: [] };
}
