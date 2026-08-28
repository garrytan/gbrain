/**
 * Additive bootstrap contract repair for legacy and custom agent workspaces.
 *
 * Fresh workspaces render the integrated write-back gate from
 * templates/bootstrap/AGENTS.md.template. Existing workspaces are user-owned,
 * so upgrades must never overwrite their AGENTS.md. This module audits for the
 * integrated gate and, on explicit --repair, appends one small marker-owned
 * block after backing up the original.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WRITEBACK_CONTRACT_BEGIN = '<!-- gbrain:writeback-contract:begin -->';
export const WRITEBACK_CONTRACT_END = '<!-- gbrain:writeback-contract:end -->';

const INTEGRATED_HARD_GATE = 'WRITE IT DOWN — SAME TURN, THROUGH THE BRAIN';
const INTEGRATED_TURN_GATE = 'Gate 7 — Write-back';

export const WRITEBACK_CONTRACT_BLOCK = `${WRITEBACK_CONTRACT_BEGIN}

## GBrain same-turn write-back

Context injection is the read side of memory. Before ending any turn where
something durable was learned, write it through GBrain in the same turn:

- Atomic facts, preferences, decisions, and commitments → \`remember\` with
  explicit provenance.
- Richer entity or project knowledge → \`put_page\` / \`add_timeline_entry\`
  through the brain tools; never edit indexed brain files behind GBrain's back.
- Verify the write with \`recall\`, \`entity\`, or \`get_page\` before claiming it
  was stored.

Skip only transient logistics, acknowledgments, and facts already verified as
present. A turn that learned something durable and recorded nothing is
incomplete.

${WRITEBACK_CONTRACT_END}`;

export interface WritebackContractAudit {
  ok: boolean;
  agentsPath: string;
  mode: 'integrated' | 'managed' | 'missing' | 'agents_missing';
  detail: string;
}

export interface WritebackContractRepair extends WritebackContractAudit {
  changed: boolean;
  backupPath: string | null;
}

function hasIntegratedWritebackContract(content: string): boolean {
  if (content.includes(INTEGRATED_HARD_GATE) && content.includes(INTEGRATED_TURN_GATE)) return true;
  const normalized = content.toLowerCase();
  return (
    /same[- ]turn/.test(normalized) &&
    /write[- ]back/.test(normalized) &&
    (normalized.includes('gbrain remember') || normalized.includes('`remember`')) &&
    normalized.includes('provenance')
  );
}

export function hasWritebackContract(content: string): boolean {
  const integrated = hasIntegratedWritebackContract(content);
  const managed = content.includes(WRITEBACK_CONTRACT_BEGIN) && content.includes(WRITEBACK_CONTRACT_END);
  return integrated || managed;
}

export function auditWritebackContract(workspaceDir: string): WritebackContractAudit {
  const agentsPath = join(workspaceDir, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    return {
      ok: false,
      agentsPath,
      mode: 'agents_missing',
      detail: 'AGENTS.md is missing; render the bootstrap contract before wiring the agent',
    };
  }
  const content = readFileSync(agentsPath, 'utf8');
  if (hasIntegratedWritebackContract(content)) {
    return { ok: true, agentsPath, mode: 'integrated', detail: 'integrated same-turn write-back gate present' };
  }
  if (content.includes(WRITEBACK_CONTRACT_BEGIN) && content.includes(WRITEBACK_CONTRACT_END)) {
    return { ok: true, agentsPath, mode: 'managed', detail: 'additive same-turn write-back contract present' };
  }
  return {
    ok: false,
    agentsPath,
    mode: 'missing',
    detail: 'same-turn write-back contract missing; context can be injected without durable capture',
  };
}

export function repairWritebackContract(workspaceDir: string): WritebackContractRepair {
  const audit = auditWritebackContract(workspaceDir);
  if (audit.ok) return { ...audit, changed: false, backupPath: null };
  if (audit.mode === 'agents_missing') {
    throw new Error(`${audit.detail}: ${audit.agentsPath}`);
  }
  if (lstatSync(audit.agentsPath).isSymbolicLink()) {
    throw new Error(`refusing to replace symlinked AGENTS.md: ${audit.agentsPath}`);
  }

  const original = readFileSync(audit.agentsPath, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(workspaceDir, '.gbrain-bootstrap-backups', stamp, 'AGENTS.md');
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, original, { flag: 'wx' });

  const next = `${original.trimEnd()}\n\n${WRITEBACK_CONTRACT_BLOCK}\n`;
  const tmp = `${audit.agentsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, audit.agentsPath);

  const repaired = auditWritebackContract(workspaceDir);
  return { ...repaired, changed: true, backupPath };
}
