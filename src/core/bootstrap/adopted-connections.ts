/**
 * Adopted harness connections (#4082): a Codex project-scoped MCP server the
 * operator manages in `<workspace>/.codex/config.toml` (streamable HTTP with
 * OAuth, logged in with `codex mcp login`) is not a bootstrap-owned
 * registration, so `bootstrap status` used to report the wire phase pending
 * and send the operator to a user-global `codex mcp add` it did not need.
 *
 * Three states, kept apart on purpose:
 *   - `detected`: the project config defines the server; nothing proves it works → `partial`;
 *   - `adopted`:  `gbrain bootstrap wire --adopt --harness codex` recorded it after a
 *                 passing `bootstrap verify`, with a redacted fingerprint → `done`;
 *   - `drifted`:  the recorded fingerprint no longer matches the effective config
 *                 (URL, header names, or the table is gone) → `partial`, re-adopt.
 *
 * The evidence lives in its own versioned sidecar beside the install receipt
 * (`<gbrain-home>/bootstrap/adopted-connections.json`), never inside the
 * receipt: uninstall tears down what bootstrap wrote, and this config is not
 * that. The fingerprint is sha256 over the canonical JSON of the server's type,
 * URL and header *names* (the shape `src/core/setup/claude-code.ts` uses for its
 * MCP entries); header values and tokens are never stored or printed. Readable
 * offline: no engine, no Codex binary.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextFile } from './atomic-write.ts';

export const ADOPTED_CONNECTIONS_VERSION = 1;
export const CODEX_PROJECT_CONFIG = join('.codex', 'config.toml');
export const DEFAULT_CODEX_SERVER_NAME = 'gbrain';

export interface DetectedCodexProjectServer {
  harness: 'codex';
  scope: 'project';
  name: string;
  transport: 'streamable_http' | 'stdio';
  /** The URL for an HTTP server, the command for stdio; never a header value. */
  target: string;
  header_names: string[];
  fingerprint: string;
}

export interface AdoptedConnection {
  harness: 'codex';
  scope: 'project';
  workspace: string;
  name: string;
  transport: DetectedCodexProjectServer['transport'];
  target: string;
  fingerprint: string;
  adopted_at: string;
  /** What proved the connection: the passing verify run it was adopted after. */
  evidence: { verify_ts: string };
}

export interface AdoptedConnectionsFile { version: typeof ADOPTED_CONNECTIONS_VERSION; connections: AdoptedConnection[] }

export type AdoptedConnectionState =
  | { state: 'adopted'; connection: AdoptedConnection; detected: DetectedCodexProjectServer }
  | { state: 'drifted'; connection: AdoptedConnection; detected: DetectedCodexProjectServer | null; why: string }
  | { state: 'detected'; detected: DetectedCodexProjectServer }
  | { state: 'none' };

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
/** sha256 over canonical JSON of what identifies the connection; header values are excluded by construction. */
export const connectionFingerprint = (parts: { type: string; target: string; header_names: string[] }): string =>
  createHash('sha256').update(JSON.stringify(canonical(parts))).digest('hex');

export function adoptedConnectionsPath(gbrainHomeDir: string): string {
  return join(gbrainHomeDir, 'bootstrap', 'adopted-connections.json');
}

/**
 * The effective `[mcp_servers.<name>]` table of the project config, or null
 * when the file or the table is absent. Throws when the file does not parse:
 * a broken config is a finding, not "no server".
 */
export function detectCodexProjectServer(ws: string, name = DEFAULT_CODEX_SERVER_NAME): DetectedCodexProjectServer | null {
  const path = join(ws, CODEX_PROJECT_CONFIG);
  if (!existsSync(path)) return null;
  const parsed = (Bun as unknown as { TOML: { parse(t: string): unknown } }).TOML.parse(readFileSync(path, 'utf8'));
  const servers = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).mcp_servers : undefined;
  const server = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)[name] : undefined;
  if (!server || typeof server !== 'object') return null;
  const table = server as Record<string, unknown>;
  const headers = table.http_headers && typeof table.http_headers === 'object' ? Object.keys(table.http_headers as object).sort() : [];
  if (typeof table.url === 'string' && table.url) {
    return { harness: 'codex', scope: 'project', name, transport: 'streamable_http', target: table.url, header_names: headers,
      fingerprint: connectionFingerprint({ type: 'codex:streamable_http', target: table.url, header_names: headers }) };
  }
  if (typeof table.command === 'string' && table.command) {
    const command = [table.command, ...(Array.isArray(table.args) ? table.args.map(String) : [])].join(' ');
    return { harness: 'codex', scope: 'project', name, transport: 'stdio', target: command, header_names: [],
      fingerprint: connectionFingerprint({ type: 'codex:stdio', target: command, header_names: [] }) };
  }
  return null;
}

export function readAdoptedConnections(gbrainHomeDir: string): AdoptedConnectionsFile {
  const path = adoptedConnectionsPath(gbrainHomeDir);
  if (!existsSync(path)) return { version: ADOPTED_CONNECTIONS_VERSION, connections: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AdoptedConnectionsFile>;
    if (parsed.version !== ADOPTED_CONNECTIONS_VERSION || !Array.isArray(parsed.connections)) return { version: ADOPTED_CONNECTIONS_VERSION, connections: [] };
    return { version: ADOPTED_CONNECTIONS_VERSION, connections: parsed.connections.filter(entry => entry && typeof entry.fingerprint === 'string' && typeof entry.workspace === 'string') };
  } catch { return { version: ADOPTED_CONNECTIONS_VERSION, connections: [] }; }
}

/** Record (or replace, per workspace + harness + name) one adopted connection. */
export function recordAdoptedConnection(gbrainHomeDir: string, connection: AdoptedConnection): AdoptedConnectionsFile {
  const current = readAdoptedConnections(gbrainHomeDir);
  const connections = [...current.connections.filter(entry => !(entry.workspace === connection.workspace && entry.harness === connection.harness && entry.name === connection.name)), connection];
  const next: AdoptedConnectionsFile = { version: ADOPTED_CONNECTIONS_VERSION, connections };
  mkdirSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true });
  atomicWriteTextFile(adoptedConnectionsPath(gbrainHomeDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The workspace's Codex connection state from the sidecar and the effective project config. */
export function adoptedConnectionState(ws: string, gbrainHomeDir: string, name = DEFAULT_CODEX_SERVER_NAME): AdoptedConnectionState {
  const connection = readAdoptedConnections(gbrainHomeDir).connections.find(entry => entry.workspace === ws && entry.harness === 'codex' && entry.name === name) ?? null;
  let detected: DetectedCodexProjectServer | null;
  try { detected = detectCodexProjectServer(ws, name); }
  catch (error) {
    const why = `${CODEX_PROJECT_CONFIG} does not parse: ${error instanceof Error ? error.message : String(error)}`;
    return connection ? { state: 'drifted', connection, detected: null, why } : { state: 'none' };
  }
  if (!connection) return detected ? { state: 'detected', detected } : { state: 'none' };
  if (!detected) return { state: 'drifted', connection, detected: null, why: `${CODEX_PROJECT_CONFIG} no longer defines mcp_servers.${name}` };
  if (detected.fingerprint !== connection.fingerprint) {
    return { state: 'drifted', connection, detected, why: `mcp_servers.${name} changed since adoption (${connection.transport} ${connection.target} → ${detected.transport} ${detected.target})` };
  }
  return { state: 'adopted', connection, detected };
}
