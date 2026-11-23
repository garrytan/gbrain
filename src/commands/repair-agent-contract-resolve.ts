import { readAgentContractEvents } from '../core/agent-contract-log.ts';
import { auditBinaryDigest, persistResolution, readResolutionInput, verifyResolution } from './doctor/audit/agent-contract-resolution.ts';
import { opError } from '../core/ops/contract.ts';
import { VERSION } from '../version.ts';

const USAGE = 'gbrain repair agent-contract-resolve --evidence-file <path> [--apply --expect <preview-hash>] --json';

export async function runAgentContractResolution(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  if (process.env.GBRAIN_ENFORCED_MEMBER !== undefined) {
    throw opError('permission_denied', 'An enforced member cannot close a host diagnostic.', 'Use the authorized local operator.');
  }
  const argv = args.filter(arg => arg !== '--json');
  const [evidenceFlag, file, applyFlag, expectFlag, expect] = argv;
  const apply = argv.length === 5 && applyFlag === '--apply' && expectFlag === '--expect' && /^[0-9a-f]{64}$/.test(expect ?? '');
  if (evidenceFlag !== '--evidence-file' || !file || file.startsWith('-') || (argv.length !== 2 && !apply)) {
    throw opError('invalid_params', 'Expected an evidence file and the receipt preview hash for apply.', USAGE);
  }
  try {
    const input = readResolutionInput(file);
    const receipt = verifyResolution(input, readAgentContractEvents(Infinity, true), await auditBinaryDigest(), VERSION);
    if (apply) {
      if (expect !== receipt) throw new Error('The evidence differs from the reviewed preview');
      persistResolution(input, receipt);
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', receipt_sha256: receipt, proof_count: input.proofs.length }));
  } catch (error) {
    throw opError('invalid_params', error instanceof Error ? error.message : 'Could not verify the resolution evidence', USAGE);
  }
}
