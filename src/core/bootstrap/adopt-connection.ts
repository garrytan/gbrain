/**
 * `gbrain bootstrap hooks --adopt --harness codex [--name <server>]` (#4082):
 * record an operator-managed Codex project connection as the wire phase's
 * evidence instead of registering a user-global `codex mcp add` entry it does
 * not need. Adoption needs proof the connection works, and the proof is the
 * install contract: the newest `gbrain bootstrap verify` run must have passed
 * and must be newer than the project config it vouches for. Nothing is written
 * to `.codex/config.toml`, no receipt registration is fabricated, and the
 * recorded fingerprint carries no header values or tokens.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
type Harness = 'claude-code' | 'codex' | 'opencode';
import { listVerifyRuns } from './status.ts';
import {
  CODEX_PROJECT_CONFIG,
  DEFAULT_CODEX_SERVER_NAME,
  adoptedConnectionsPath,
  detectCodexProjectServer,
  recordAdoptedConnection,
} from './adopted-connections.ts';

export interface AdoptConnectionResult { code: number; lines: string[] }

export function adoptConnection(ws: string, gbrainHomeDir: string, harness: Harness, name = DEFAULT_CODEX_SERVER_NAME): AdoptConnectionResult {
  if (harness !== 'codex') {
    return { code: 2, lines: [`--adopt applies to a Codex project config (${CODEX_PROJECT_CONFIG}); ${harness} registrations are bootstrap-owned — run \`gbrain bootstrap hooks --harness ${harness}\` without --adopt`] };
  }
  let detected: ReturnType<typeof detectCodexProjectServer>;
  try {
    detected = detectCodexProjectServer(ws, name);
  } catch (error) {
    return { code: 1, lines: [`${CODEX_PROJECT_CONFIG} does not parse: ${error instanceof Error ? error.message : String(error)} — fix the file, then re-run`] };
  }
  if (!detected) {
    return { code: 1, lines: [`nothing to adopt: ${CODEX_PROJECT_CONFIG} does not define mcp_servers.${name} in this workspace (pass --name <server> for another table, or run \`gbrain bootstrap hooks --harness codex\` for a bootstrap-owned registration)`] };
  }
  const verify = listVerifyRuns(gbrainHomeDir)[0] ?? null;
  if (!verify || !verify.ok) {
    return { code: 1, lines: [verify
      ? `the newest \`gbrain bootstrap verify\` run (${verify.ts}) failed: ${verify.checks_failed.join(', ')} — fix it and re-run verify before adopting`
      : 'no `gbrain bootstrap verify` run on record — adoption needs a passing verify as evidence; run it from this workspace first'] };
  }
  const configMtime = statSync(join(ws, CODEX_PROJECT_CONFIG)).mtime.toISOString();
  if (configMtime > verify.ts) {
    return { code: 1, lines: [`${CODEX_PROJECT_CONFIG} changed at ${configMtime}, after the newest passing verify (${verify.ts}) — re-run \`gbrain bootstrap verify\`, then adopt`] };
  }
  recordAdoptedConnection(gbrainHomeDir, {
    harness: 'codex',
    scope: 'project',
    workspace: ws,
    name,
    transport: detected.transport,
    target: detected.target,
    fingerprint: detected.fingerprint,
    adopted_at: new Date().toISOString(),
    evidence: { verify_ts: verify.ts },
  });
  return {
    code: 0,
    lines: [
      `adopted codex project connection mcp_servers.${name} (${detected.transport} ${detected.target}) — evidence: verify ${verify.ts}`,
      `recorded in ${adoptedConnectionsPath(gbrainHomeDir)} (fingerprint ${detected.fingerprint.slice(0, 12)}…; no tokens stored); \`gbrain bootstrap status\` now reports the wire phase done`,
    ],
  };
}
