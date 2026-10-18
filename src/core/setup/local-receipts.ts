/**
 * Read-only view of the `gbrain setup` connection receipts that belong to
 * this install (D8). Each `gbrain setup <harness>` writes a local-stdio
 * receipt beside the harness config (`.gbrain-connection-<harness>-<name>*.json`,
 * src/core/setup/claude-code.ts) recording the three consent decisions and
 * whether the harness now spawns a stdio `gbrain serve`. Two readers outside
 * setup need that record:
 *
 *   - provider use: a recorded `providers: declined` keeps gbrain from
 *     contacting a provider it was not asked to use (model discovery, doctor),
 *     even when provider keys sit in the environment. Opt-outs win: one live
 *     receipt that declines is enough.
 *   - the SessionStart hook: a Claude Code receipt means the harness starts a
 *     stdio serve for every new session, so the hook may wait briefly for it.
 *
 * File reads only (engine-free, no harness code imported) so the hook and the
 * gateway can call it. A receipt that is unreadable, hosted (no
 * `connection: 'local-stdio'`), removed, or written for another install
 * (`gbrain_home`) is ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '../config.ts';
import { claudeUserMcpConfigPath, codexConfigPath } from '../bootstrap/host-specs.ts';

export interface LocalSetupRecord {
  path: string;
  harness: string;
  name: string;
  status: 'prepared' | 'installed';
  scope?: 'user' | 'project';
  projectDir?: string;
  providers?: 'accepted' | 'declined';
}

const RECEIPT_FILE = /^\.gbrain-connection-.+\.json$/;

function parse(path: string, home: string): LocalSetupRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.connection !== 'local-stdio' || typeof raw.setup_receipt_version !== 'number') return null;
  if (raw.gbrain_home !== home || (raw.status !== 'prepared' && raw.status !== 'installed')) return null;
  if (typeof raw.harness !== 'string' || typeof raw.name !== 'string') return null;
  const providers = (raw.consent as { providers?: { value?: unknown } } | undefined)?.providers?.value;
  return {
    path,
    harness: raw.harness,
    name: raw.name,
    status: raw.status,
    ...(raw.scope === 'user' || raw.scope === 'project' ? { scope: raw.scope } : {}),
    ...(typeof raw.project_dir === 'string' ? { projectDir: raw.project_dir } : {}),
    ...(providers === 'accepted' || providers === 'declined' ? { providers } : {}),
  };
}

/** Every live local-stdio setup receipt this install (`configDir()`) wrote. */
export function localSetupRecords(home: string = configDir()): LocalSetupRecord[] {
  const dirs = [...new Set([dirname(claudeUserMcpConfigPath()), dirname(codexConfigPath())])];
  const records: LocalSetupRecord[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => RECEIPT_FILE.test(n)).sort()) {
      const record = parse(join(dir, name), home);
      if (record) records.push(record);
    }
  }
  return records;
}

/** The receipt that recorded provider use as declined for this install, or null. */
export function providerDeclineRecord(home?: string): LocalSetupRecord | null {
  return localSetupRecords(home).find((r) => r.providers === 'declined') ?? null;
}

/**
 * True when an installed `gbrain setup claude-code` registration makes Claude
 * Code spawn a stdio serve for a session started in `cwd`: a user-scope
 * receipt, or a project-scope receipt for exactly that directory (Claude Code
 * keys project MCP entries by the session's directory).
 */
export function claudeCodeSpawnsServe(cwd: string, home?: string): boolean {
  return localSetupRecords(home).some((r) => r.harness === 'claude-code' && r.status === 'installed'
    && (r.scope !== 'project' || r.projectDir === cwd));
}
