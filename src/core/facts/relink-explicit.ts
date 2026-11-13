import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { readFacts } from '../persistence/prepared-maintenance.ts';
import { wholeBodySnapshot } from '../persistence/segmented-apply.ts';
import { nativePathMayBeGitCheckout } from '../persistence/native-file-target.ts';
import {
  assertExplicitRelinkPrivacy, exactRelinkTarget, explicitRelinkFact, explicitRelinkRefusal, explicitRelinkScope, relinkFactHash,
  RELINK_OPERATION, submitRelinkGroup, type ExplicitRelinkPin, type RelinkIntent, type RelinkIntentFact,
} from './relink-publish.ts';

interface ExplicitRelinkPlan {
  version: 1;
  source: string;
  target: string;
  runId: string;
  fact: RelinkIntentFact;
  pin: ExplicitRelinkPin;
}
const EXPLICIT_NOTE = 'entity relinked by operator';

function invalid(message: string): never {
  throw opError('invalid_params', message, 'Preview one active fact against an existing entity on the brain host. Apply the exact saved preview.');
}

function relinkIntent(plan: ExplicitRelinkPlan): RelinkIntent {
  return { kind: RELINK_OPERATION, run_id: plan.runId, queue_conflict: false, facts: [plan.fact], explicit: plan.pin };
}

export async function previewExplicitRelink(engine: BrainEngine, source: string, target: string, factId: number, evidence: string) {
  if (!Number.isInteger(factId) || factId < 1 || factId > 2_147_483_647 || !evidence.trim() || evidence.length > 500) {
    return invalid('Use one fact ID and up to 500 characters of evidence.');
  }
  return engine.transaction(async tx => {
    const scope = await explicitRelinkScope(tx, source);
    const page = await wholeBodySnapshot(tx, await tx.readPageSnapshot(target, { sourceId: source }), 'facts relink');
    if (!scope || !page || !await exactRelinkTarget(tx, source, target)) return invalid('The exact canonical entity page must exist in the selected source.');
    const [fact] = await readFacts(tx, source, [factId]);
    const full = await explicitRelinkFact(tx, source, factId);
    if (!fact || !full) return invalid('The fact does not exist in the selected source.');
    const root = scope.local_path ?? (source === 'default' ? await tx.getConfig('sync.repo_path') : null);
    assertExplicitRelinkPrivacy(scope.canonical_git || (full.visibility === 'private' && root !== null && nativePathMayBeGitCheckout(root)), full.visibility);

    const plan: ExplicitRelinkPlan = {
      version: 1, source, target, runId: randomUUID(),
      fact: { id: factId, hash: relinkFactHash(fact), tier: 'manual', model: null, note: EXPLICIT_NOTE },
      pin: { brainId: scope.brain_id, sourceIncarnation: page.sourceIncarnation, pageId: page.page.id, revision: page.revision,
        factHash: full.hash, evidenceHash: digest(evidence.trim()) },
    };
    const refusal = await explicitRelinkRefusal(tx, source, target, relinkIntent(plan));
    if (refusal) return invalid(`The fact cannot be linked (${refusal}).`);
    return { plan, checksum: digest(plan) };
  });
}

export async function applyExplicitRelink(engine: BrainEngine, config: GBrainConfig, sourceId: string, input: unknown, opts: { residentOnly?: boolean } = {}) {
  if (!input || typeof input !== 'object') return invalid('A saved explicit relink preview is required.');
  const { plan, checksum } = input as { plan?: ExplicitRelinkPlan; checksum?: string };
  if (!plan || plan.version !== 1 || !isWriteRequestId(plan.runId) || plan.source !== sourceId
    || typeof plan.target !== 'string' || !plan.target || !plan.pin || !plan.fact || digest(plan) !== checksum) {
    return invalid('The explicit relink preview is invalid or changed.');
  }
  const { fact, pin } = plan;
  if (!Number.isInteger(fact.id) || fact.id < 1 || fact.id > 2_147_483_647 || fact.tier !== 'manual'
    || fact.model !== null || fact.note !== EXPLICIT_NOTE
    || !/^[a-f0-9]{64}$/.test(fact.hash) || !/^[a-f0-9]{64}$/.test(pin.factHash) || !/^[a-f0-9]{64}$/.test(pin.evidenceHash)
    || !isWriteRequestId(pin.brainId) || !isWriteRequestId(pin.sourceIncarnation)
    || !Number.isSafeInteger(pin.pageId) || pin.pageId < 1 || !isWriteRequestId(pin.revision)) {
    return invalid('The explicit relink preview has invalid pins.');
  }
  const scope = await explicitRelinkScope(engine, plan.source);
  if (!scope || scope.brain_id !== pin.brainId || scope.incarnation !== pin.sourceIncarnation) {
    return invalid('The preview belongs to another brain or source incarnation.');
  }
  return submitRelinkGroup(engine, config, plan.source, plan.target, { ...relinkIntent(plan), ...(opts.residentOnly ? { serve_only: true } : {}) }, opts);
}
