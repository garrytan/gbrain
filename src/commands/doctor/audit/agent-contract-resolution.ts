import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentContractEvent } from '../../../core/agent-contract-log.ts';
import { gbrainPath } from '../../../core/config.ts';
import { digest } from '../../../core/persistence/digest.ts';
import { readPrivateAuditJson } from './private-audit-json.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const observation = z.strictObject({
  probe: z.string().regex(/^[a-z][a-z0-9_-]{2,79}$/),
  observed_error_code: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  actionable_next_step: z.literal(true),
  recovered: z.literal(true),
  reproduction_sha256: hash,
  recovery_sha256: hash,
});
const proof = z.strictObject({
  event_sha256: hash,
  evidence: observation,
  evidence_sha256: hash,
  verified_at: z.iso.datetime({ offset: true }),
});
const resolution = z.strictObject({
  version: z.literal(1),
  verified_binary_sha256: hash,
  proofs: z.array(proof).min(1).max(100),
});
export type AgentContractResolution = z.infer<typeof resolution>;
type Event = AgentContractEvent & { ts: string };

export const agentContractEventDigest = (event: Event) => digest(event);

export function isAgentContractFault(event: AgentContractEvent): boolean {
  return event.code === 'internal_error' || event.code === 'internal' || event.has_suggestion === false;
}

const folder = () => gbrainPath('agent-contract', 'resolutions');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function readResolutionInput(path: string): AgentContractResolution {
  return resolution.parse(readPrivateAuditJson(path, 128 * 1024));
}

export async function auditBinaryDigest(): Promise<string> {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(process.execPath)) sha.update(chunk);
  return sha.digest('hex');
}

export function verifyResolution(
  input: AgentContractResolution, events: readonly Event[], binary: string, version: string, now = Date.now(),
): string {
  if (input.verified_binary_sha256 !== binary) throw new Error('The evidence is for a different executable');
  const eligible = events.filter(event => isAgentContractFault(event) && event.version && event.version !== version);
  const seen = new Set<string>();
  for (const entry of input.proofs) {
    const matches = eligible.filter(event => agentContractEventDigest(event) === entry.event_sha256);
    const verified = Date.parse(entry.verified_at);
    const occurred = Date.parse(matches[0]?.ts ?? '');
    if (matches.length !== 1 || seen.has(entry.event_sha256) ||
        !Number.isFinite(occurred) || !Number.isFinite(verified) || verified <= occurred || verified > now ||
        digest(entry.evidence) !== entry.evidence_sha256 ||
        ['internal', 'internal_error'].includes(entry.evidence.observed_error_code)) {
      throw new Error('Each proof must name one historical fault and a later verification');
    }
    seen.add(entry.event_sha256);
  }
  return digest(input);
}

function privateFolder(path: string): void {
  const state = lstatSync(path);
  if (!state.isDirectory() || (process.getuid !== undefined &&
      (state.uid !== process.getuid() || (state.mode & 0o077) !== 0))) throw new Error('Resolution directory must be owner-only');
}

export function persistResolution(input: AgentContractResolution, expected: string): void {
  if (digest(input) !== expected) throw new Error('Resolution changed since preview');
  const dir = folder();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateFolder(dir);
  const temporary = join(dir, `tmp-${randomUUID()}`);
  const final = join(dir, `${expected}.json`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(input) + '\n'); } finally { closeSync(fd); }
    try { linkSync(temporary, final); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(readResolutionInput(final)) !== expected) throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}

export async function readAgentContractResolutions(events: readonly Event[], version: string): Promise<ReadonlySet<string>> {
  const dir = folder();
  try { privateFolder(dir); } catch (error) {
    if (absent(error)) return new Set();
    throw error;
  }
  const files = readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
  if (!files.length) return new Set();
  if (files.length > 500) throw new Error('Resolution directory exceeds the supported audit size');
  const binary = await auditBinaryDigest();
  const resolved = new Set<string>();
  for (const name of files) {
    const entry = readResolutionInput(join(dir, name));
    if (digest(entry) !== name.slice(0, -5)) throw new Error('A retained resolution no longer matches its receipt');
    if (entry.verified_binary_sha256 === binary) {
      const retained = new Set(events.map(agentContractEventDigest));
      const proofs = entry.proofs.filter(item => retained.has(item.event_sha256));
      if (proofs.length) {
        verifyResolution({ ...entry, proofs }, events, binary, version);
        for (const item of proofs) resolved.add(item.event_sha256);
      }
    }
  }
  return resolved;
}
