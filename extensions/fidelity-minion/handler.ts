import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { MinionWorker, UnrecoverableError, type MinionHandler } from '../../src/core/minions/index.ts';
import { parseFidelityContracts, prepareFidelityExcerpts, renderFidelityNarrative } from './concept-fidelity.ts';
import { stripFenceSections } from '../../src/core/cycle/concept-publication.ts';
import { validateMaintenanceInputs, type MaintenanceInputGuard } from '../../src/core/persistence/maintenance-input-guard.ts';
import { guardedDatabasePagePreflight, publishGuardedMaintenancePage } from '../../src/core/persistence/prepared-maintenance.ts';
import { declareDerivation, derivedWriteTrust } from '../../src/core/trust/taint.ts';

import { storedTrustTier } from '../../src/core/trust/tier.ts';

export const JOB = 'fidelity-concept';
const owner = 'fidelity-minion-v1';
const ownedFields = new Set(['type', 'title', 'generated_by', 'visibility', 'fidelity_input_digest', 'fidelity_narrative_digest', 'trust_tier']);
const digestText = (text: string) => createHash('sha256').update(text).digest('hex');

export interface Target {
  sourceId: string;
  topic: string;
}

export function fidelityQueue({ sourceId, topic }: Target): string {
  return `fidelity-${digestText(JSON.stringify([sourceId, topic]))}`;
}

export async function prepareConcept(engine: BrainEngine, target: Target) {
  const { sourceId, topic } = target;
  if (engine.kind !== 'postgres') throw new UnrecoverableError('This handler requires PostgreSQL');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) throw new UnrecoverableError('Invalid approved topic');
  const slug = `concepts/minion-fidelity-${topic}`;
  const approvalKey = `cycle.synthesize_concepts.fidelity.${sourceId}`;
  const [source] = await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw new UnrecoverableError('Source is not active');
  const [approval] = await engine.executeRaw<{ value: string; version: string }>(
    'SELECT value, xmin::text AS version FROM config WHERE key=$1', [approvalKey]);
  const contract = parseFidelityContracts(approval?.value ?? null).get(topic);
  if (!approval || !contract) throw new UnrecoverableError('No active fidelity approval');

  const pages = await Promise.all(contract.map(async ({ atom }) => {
    const snapshot = await engine.readPageSnapshot(atom, { sourceId });
    const page = snapshot?.page;
    if (!snapshot?.revision || page?.type !== 'atom' || page.frontmatter?.imported_from ||
      (Array.isArray(page.frontmatter?.concepts) && page.frontmatter.concepts.length > 0) ||
      !Array.isArray(page.frontmatter?.fidelity_concepts) || !page.frontmatter.fidelity_concepts.includes(topic)) {
      throw new UnrecoverableError('Approved atom is missing or changed membership');
    }
    const [stored] = await engine.executeRaw<{ trust_tier: string | null }>(
      'SELECT trust_tier FROM pages WHERE id=$1 AND knowledge_revision=$2 AND deleted_at IS NULL',
      [page.id, snapshot.revision]);
    if (!stored) throw new UnrecoverableError('Approved atom changed while preparing');
    return { id: Number(page.id), slug: atom, revision: snapshot.revision, trustTier: stored.trust_tier,
      body: stripFenceSections(page.compiled_truth) };
  }));
  const excerpts = prepareFidelityExcerpts(contract, { atomSlugs: pages.map(p => p.slug), atomBodies: pages.map(p => p.body) });
  const narrative = renderFidelityNarrative(pages.map(p => p.slug), excerpts);
  if (!narrative) throw new UnrecoverableError('Approved ordering failed validation');
  const guard: MaintenanceInputGuard = {
    approvalKey, approvalVersion: approval.version, sourceIncarnation: source.incarnation,
    pages: pages.map(({ slug, revision, trustTier }) => ({ slug, revision, trustTier })),
  };
  const digest = digestText(JSON.stringify([2, guard]));
  const inputs = pages.map(page => ({ table: 'pages' as const, id: page.id, tier: storedTrustTier(page.trustTier) }));
  const derivation = declareDerivation(derivedWriteTrust({ inputs, channel: 'derive:concepts' }), inputs);
  return { slug, sourceId, guard, digest, narrative, derivation, title: topic.replaceAll('-', ' ') };
}

export async function publishConcept(engine: BrainEngine, prepared: Awaited<ReturnType<typeof prepareConcept>>, deadlineAtMs?: number | null) {
  const { sourceId, slug, guard, digest, title, narrative, derivation } = prepared;
  const authority = await guardedDatabasePagePreflight(engine, sourceId, deadlineAtMs);
  if (!authority) throw new UnrecoverableError('A managed persistence coordinator is required');
  const current = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  if (current && (current.page.deleted_at || current.page.frontmatter?.generated_by !== owner ||
    current.page.source_path || current.page.timeline?.trim() || current.tags.length ||
    current.page.title !== title || current.page.type !== 'concept' || current.page.frontmatter?.visibility !== 'private' ||
    Object.keys(current.page.frontmatter).some(key => !ownedFields.has(key)) ||
    current.page.frontmatter?.fidelity_narrative_digest !== digestText(current.page.compiled_truth.trim()))) {
    throw new UnrecoverableError('Existing output must be reviewed before replacement');
  }
  if (current?.page.frontmatter?.fidelity_input_digest === digest) {
    await engine.transaction(tx => validateMaintenanceInputs(tx, sourceId, guard));
    return { status: 'unchanged', slug, revision: current.revision };
  }
  const content = serializeMarkdown({ generated_by: owner, visibility: 'private', fidelity_input_digest: digest,
    fidelity_narrative_digest: digestText(narrative.trim()) },
    narrative, '', { type: 'concept', title, tags: [] });
  const receipt = await publishGuardedMaintenancePage(engine, authority, slug, content, {
    expectedRevision: current?.revision ?? null,
    derivation,
    projectConceptLinks: true,
  }, guard);
  return { status: 'published', slug, receipt };
}

export function makeFidelityHandler(engine: BrainEngine, target: Target,
    extraction?: Pick<MaintenanceInputGuard, 'pages' | 'activation'>): MinionHandler {
  return async job => {
    if (job.data.sourceId !== target.sourceId || job.data.topic !== target.topic) {
      throw new UnrecoverableError('Fidelity job target does not match this worker');
    }
    if (job.signal.aborted || !await job.isActive()) throw new Error('Job no longer active');
    const prepared = await prepareConcept(engine, target);
    if (extraction) {
      prepared.guard.evidencePages = extraction.pages;
      prepared.guard.activation = extraction.activation;
    }
    if (job.signal.aborted || !await job.isActive()) throw new Error('Job no longer active');
    const deadline = job.deadlineAtMs === null ? null : job.deadlineAtMs - 3000;
    try {
      return await publishConcept(engine, prepared, deadline);
    } catch (error) {
      if (error instanceof OperationError && ['write_pending', 'revision_conflict'].includes(error.code)) {
        return { status: error.code, slug: prepared.slug, receipt: error.writeRequest };
      }
      throw error;
    }
  };
}

export function registerFidelityMinion(worker: MinionWorker, engine: BrainEngine, target: Target): void {
  worker.register(JOB, makeFidelityHandler(engine, target));
}
