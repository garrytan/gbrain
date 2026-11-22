import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import { strictArgsRefusal } from '../cli/strict-args.ts';
import { shellQuote } from '../core/agent-output.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { loadConfig } from '../core/config.ts';
import { isEmbeddedEngine } from '../core/embedded-engine.ts';
import type { BrainEngine } from '../core/engine.ts';
import { readDateVerificationIncarnation, readFactDateAnchors, useFactDateAuditSnapshot } from '../core/engine-sql/fact-date-verification.ts';
import { FACT_DATE_REVOCATION, FACT_DATE_VERIFICATION, factDateProof, matchesDatedExcerpt } from '../core/facts/fact-date-proof.ts';
import { clearHealthMemo } from '../core/health-memo.ts';
import { OperationError, opError, type OperationContext } from '../core/ops/contract.ts';
import { submissionAuthority } from '../core/persistence/authority.ts';
import { requireUuid } from '../core/persistence/digest.ts';
import { factDateReceiptSlug, publishFactDateVerification, requireRevocableFactDateReceipt, requireSourceWideDateAuthority, revokeFactDateVerification } from '../core/persistence/fact-date-verification.ts';
import { previewChangedError, previewHash } from '../core/persistence/preview-approval.ts';

const KIND = 'fact-date-verification';
const HELP = `Usage: gbrain repair ${KIND} --source <id> --evidence-file <path> [--apply --expect <preview-hash>] [--json]

Read-only preview of a local operator's reviewed date evidence. See docs/guides/repair.md#fact-date-verification
for the JSON manifest. Apply journals receipts for those exact proofs or revocations.`;

const requestId = z.uuid().transform(requireUuid);
const reviewedEvidence = factDateProof.omit({ fact_digest: true, source_incarnation: true }).extend({
  claim_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifest = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('verify'), rows: z.array(z.strictObject({ request_id: requestId, evidence: reviewedEvidence })).min(1) }),
  z.strictObject({ mode: z.literal('revoke'), rows: z.array(z.strictObject({ request_id: requestId, receipt_id: requestId })).min(1) }),
]);
type Manifest = z.output<typeof manifest>;

function invalidEvidence(): OperationError {
  return opError('invalid_params', 'Invalid fact date verification manifest.',
    'Pass a regular JSON file with mode verify or revoke, unique request IDs, and unique fact or verification receipt IDs.');
}

function readManifest(path: string): Manifest {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let raw: string;
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.size > 1024 * 1024) throw invalidEvidence();
      const bytes = Buffer.alloc(file.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== file.size) throw invalidEvidence();
      raw = bytes.subarray(0, offset).toString('utf8');
    } finally { closeSync(fd); }
    const parsed = manifest.parse(JSON.parse(raw));
    if (new Set(parsed.rows.map(row => row.request_id)).size !== parsed.rows.length) throw invalidEvidence();
    const targets = parsed.mode === 'verify' ? parsed.rows.map(row => row.evidence.fact_id) : parsed.rows.map(row => row.receipt_id);
    if (new Set<string | number>(targets).size !== parsed.rows.length) throw invalidEvidence();
    parsed.rows.sort((a, b) => a.request_id.localeCompare(b.request_id, 'en'));
    return parsed;
  } catch { throw invalidEvidence(); }
}

async function planDateReceipts(ctx: OperationContext, source: string, input: Manifest) {
  return ctx.engine.transaction(async tx => {
    await useFactDateAuditSnapshot(tx);
    const incarnation = await readDateVerificationIncarnation(tx, source);
    const brain = await tx.readPersistenceBrainId();
    if (!brain || !incarnation) throw opError('invalid_params', 'No active source in a persistence-enabled brain matches this preview.',
      'Use a source from gbrain sources list on the brain host.');
    const operation = input.mode === 'verify' ? FACT_DATE_VERIFICATION : FACT_DATE_REVOCATION;
    const authority = await submissionAuthority({ ...ctx, engine: tx }, operation, source, incarnation, factDateReceiptSlug(input.rows[0]!.request_id));
    requireSourceWideDateAuthority(authority);
    const approval = { brainId: brain, principal: authority.principal };
    const hashPrefix = [KIND, 1, approval, source, incarnation, input.mode];
    if (input.mode === 'verify') {
      const anchors = await readFactDateAnchors(tx, input.rows.map(row => ({ ...row.evidence, source_id: source })));
      const byIndex = new Map(anchors.map(anchor => [anchor.index, anchor]));
      const rows = input.rows.map((row, index) => {
        const { claim_sha256, ...evidence } = row.evidence;
        const anchor = byIndex.get(index);
        if (!anchor || anchor.claim_sha256 !== claim_sha256) throw opError('revision_conflict',
          `Fact ${evidence.fact_id} changed or is unavailable.`,
          'Re-read the active fact before making a new preview.');
        const proof = { ...evidence, source_incarnation: incarnation, fact_digest: anchor.fact_digest };
        if (!matchesDatedExcerpt(proof, anchor.excerpt)) throw opError('revision_conflict',
          `The dated archive excerpt for fact ${evidence.fact_id} changed or is unavailable.`,
          'Re-read the active fact and retained original revision before making a new preview.');
        return { request_id: row.request_id, proof };
      });
      return { incarnation, approval, rows, hash: previewHash([...hashPrefix, rows]) };
    }
    for (const row of input.rows) await requireRevocableFactDateReceipt(tx, source, incarnation, row.receipt_id);
    return { incarnation, approval, rows: input.rows, hash: previewHash([...hashPrefix, input.rows]) };
  }, { readOnly: true });
}

export async function runFactDateVerificationCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const refusal = strictArgsRefusal('repair', args);
  if (refusal) throw refusal;
  if (process.env.GBRAIN_ENFORCED_MEMBER !== undefined || isEmbeddedEngine(engine)) throw opError('permission_denied',
    'Fact date verification requires a registered operator in the local host CLI.',
    'Run this repair on the brain host through the registered local CLI writer.');
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const source = flag('--source');
  const path = flag('--evidence-file');
  const expect = flag('--expect');
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  if (!source || !path || apply !== (expect !== undefined)) throw opError('invalid_params',
    'Use --source and --evidence-file. Apply requires both --apply and --expect.',
    `Run gbrain repair ${KIND} --help.`);
  const input = readManifest(path);
  const ctx: OperationContext = { engine, config: loadConfig() ?? { engine: engine.kind }, sourceId: source,
    remote: false, dryRun: !apply, logger: { info: console.error, warn: console.error, error: console.error } };
  const plan = await planDateReceipts(ctx, source, input);
  const argv = ['gbrain', 'repair', KIND, '--source', source, '--evidence-file', path];
  const previewCommand = shellQuote(argv);
  if (!apply) {
    const command = shellQuote([...argv, '--apply', '--expect', plan.hash, ...(json ? ['--json'] : [])]);
    console.log(json ? JSON.stringify({ mode: 'preview', action: input.mode, source_id: source,
      preview_hash: plan.hash, rows: plan.rows, apply_command: command }, null, 2)
      : `${input.rows.length} reviewed date ${input.mode === 'verify' ? 'proof' : 'revocation'} receipt(s).\n${command}`);
    return;
  }
  if (expect !== plan.hash) throw previewChangedError(expect!, previewCommand);
  const receipts: Array<{ request_id: string; receipt_id: string; state: string }> = [];
  let failed: { request_id: string; code: string; message: string } | undefined;
  for (const row of plan.rows) {
    try {
      const receipt = 'proof' in row ? await publishFactDateVerification(ctx, source, row.request_id, row.proof, plan.approval)
        : await revokeFactDateVerification(ctx, source, row.request_id, plan.incarnation, row.receipt_id, plan.approval);
      receipts.push({ request_id: row.request_id, receipt_id: receipt.id, state: receipt.state });
    } catch (error) {
      failed = { request_id: row.request_id, code: error instanceof OperationError ? error.code : 'internal_error',
        message: error instanceof OperationError ? error.message : 'The receipt status needs inspection.' };
      break;
    }
  }
  clearHealthMemo(engine);
  if (failed) setCliExitVerdict(1);
  console.log(json ? JSON.stringify({ mode: 'apply', action: input.mode, source_id: source,
    preview_hash: plan.hash, complete: !failed, receipts, ...(failed ? { failed } : {}) }, null, 2)
    : `${receipts.length} of ${input.rows.length} receipt(s) committed.${failed ? ` Stopped at ${failed.request_id}. ${failed.message}` : ''}`);
}
