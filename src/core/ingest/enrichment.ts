import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { slugifySegment } from '../sync.ts';
import {
  CodexOAuthInferenceError,
  GBRAIN_INGEST_INFERENCE_MODEL,
  runCodexOAuthInference,
  type CodexOAuthRunner,
  type CodexOAuthInferenceErrorCode,
} from './codex-oauth.ts';

type EntityKind = 'people' | 'organizations' | 'concepts';

interface CandidateEntity {
  name: string;
  citation?: string;
  confidence?: number;
}

interface CandidateRelationship {
  from: string;
  to: string;
  type?: string;
  citation?: string;
  confidence?: number;
}

interface CandidateTimeline {
  date: string;
  summary: string;
  citation?: string;
  confidence?: number;
}

export interface EnrichmentOutput {
  people: CandidateEntity[];
  organizations: CandidateEntity[];
  concepts: CandidateEntity[];
  relationships: CandidateRelationship[];
  timeline: CandidateTimeline[];
}

export interface EnrichAcceptedSourceRequest {
  engine: BrainEngine;
  sourceSlug: string;
  sourceTitle: string;
  sourceText: string;
  runner?: CodexOAuthRunner;
  allowPartial?: boolean;
  signal?: AbortSignal;
}

export interface EnrichAcceptedSourceResult {
  status: 'enriched' | 'skipped';
  updated_slugs: string[];
  skipped: number;
}

export type BoundedEnrichmentStatus =
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'timeout'
  | 'configuration_error';

export interface BoundedEnrichmentResult {
  status: BoundedEnrichmentStatus;
  error_code?: CodexOAuthInferenceErrorCode | 'enrichment_failed';
  message?: string;
  reason?: 'disabled' | 'source_noop';
  updated_slugs?: string[];
  skipped?: number;
  raw_status?: EnrichAcceptedSourceResult['status'];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function hasCitation(candidate: { citation?: string }): boolean {
  return typeof candidate.citation === 'string' && candidate.citation.trim().length > 0;
}

function entitySlug(kind: EntityKind, name: string): string {
  const segment = slugifySegment(name.replace(/\./g, ' ')) || 'unknown';
  if (kind === 'people') return `people/${segment}`;
  if (kind === 'organizations') return `companies/${segment}`;
  return `concepts/${segment}`;
}

function entityType(kind: EntityKind): PageType {
  if (kind === 'people') return 'person';
  if (kind === 'organizations') return 'company';
  return 'concept';
}

function validateEntity(raw: unknown, kind: EntityKind, allowPartial: boolean): CandidateEntity | null {
  const r = raw as Record<string, unknown>;
  const candidate: CandidateEntity = {
    name: cleanName(r?.name),
    citation: typeof r?.citation === 'string' ? r.citation.trim() : undefined,
    confidence: typeof r?.confidence === 'number' ? r.confidence : undefined,
  };
  if (!candidate.name || !hasCitation(candidate)) {
    if (allowPartial) return null;
    throw new Error(`${kind} enrichment candidate requires name and citation`);
  }
  if (candidate.confidence !== undefined && candidate.confidence < 0.45) return null;
  return candidate;
}

function validateRelationship(raw: unknown, allowPartial: boolean): CandidateRelationship | null {
  const r = raw as Record<string, unknown>;
  const candidate: CandidateRelationship = {
    from: cleanName(r?.from),
    to: cleanName(r?.to),
    type: typeof r?.type === 'string' ? slugifySegment(r.type) : 'related',
    citation: typeof r?.citation === 'string' ? r.citation.trim() : undefined,
    confidence: typeof r?.confidence === 'number' ? r.confidence : undefined,
  };
  if (!candidate.from || !candidate.to || !hasCitation(candidate)) {
    if (allowPartial) return null;
    throw new Error('relationship enrichment candidate requires from, to, and citation');
  }
  if (candidate.confidence !== undefined && candidate.confidence < 0.45) return null;
  return candidate;
}

function validateTimeline(raw: unknown, allowPartial: boolean): CandidateTimeline | null {
  const r = raw as Record<string, unknown>;
  const candidate: CandidateTimeline = {
    date: typeof r?.date === 'string' ? r.date.trim() : '',
    summary: typeof r?.summary === 'string' ? r.summary.trim() : '',
    citation: typeof r?.citation === 'string' ? r.citation.trim() : undefined,
    confidence: typeof r?.confidence === 'number' ? r.confidence : undefined,
  };
  if (!/^\d{4}-\d{2}-\d{2}/.test(candidate.date) || !candidate.summary || !hasCitation(candidate)) {
    if (allowPartial) return null;
    throw new Error('timeline enrichment candidate requires ISO date, summary, and citation');
  }
  if (candidate.confidence !== undefined && candidate.confidence < 0.45) return null;
  return candidate;
}

export function validateEnrichmentOutput(rawText: string, opts: { allowPartial?: boolean } = {}): EnrichmentOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('enrichment output must be valid JSON');
  }
  const obj = parsed as Record<string, unknown>;
  const allowPartial = opts.allowPartial === true;

  return {
    people: asArray(obj.people).map(v => validateEntity(v, 'people', allowPartial)).filter((v): v is CandidateEntity => !!v),
    organizations: asArray(obj.organizations).map(v => validateEntity(v, 'organizations', allowPartial)).filter((v): v is CandidateEntity => !!v),
    concepts: asArray(obj.concepts).map(v => validateEntity(v, 'concepts', allowPartial)).filter((v): v is CandidateEntity => !!v),
    relationships: asArray(obj.relationships).map(v => validateRelationship(v, allowPartial)).filter((v): v is CandidateRelationship => !!v),
    timeline: asArray(obj.timeline).map(v => validateTimeline(v, allowPartial)).filter((v): v is CandidateTimeline => !!v),
  };
}

function enrichmentPrompt(sourceTitle: string, sourceText: string): string {
  return [
    'Extract only evidence-backed durable memory candidates from this source.',
    'Return compact JSON with keys: people, organizations, concepts, relationships, timeline.',
    'Every candidate MUST include a short citation copied from the source text.',
    'Do not infer uncited facts. Do not include raw transcript beyond citations.',
    '',
    `Title: ${sourceTitle}`,
    '',
    sourceText.slice(0, 12000),
  ].join('\n');
}

async function upsertEntity(engine: BrainEngine, kind: EntityKind, entity: CandidateEntity, sourceSlug: string): Promise<string> {
  const slug = entitySlug(kind, entity.name);
  const existing = await engine.getPage(slug);
  const evidence = `- [[${sourceSlug}]]: "${entity.citation}"`;
  const current = existing?.compiled_truth ?? '';
  const compiled = current.includes(evidence)
    ? current
    : [current || `# ${entity.name}`, '', '## Evidence', evidence].filter(Boolean).join('\n');
  await engine.putPage(slug, {
    type: entityType(kind),
    title: entity.name,
    compiled_truth: compiled,
    frontmatter: {
      gbrain_ingest_enriched: true,
      evidence_sources: [sourceSlug],
    },
  });
  await engine.addLink(slug, sourceSlug, entity.citation, 'cites', 'manual');
  return slug;
}

export async function enrichAcceptedSource(req: EnrichAcceptedSourceRequest): Promise<EnrichAcceptedSourceResult> {
  const response = await runCodexOAuthInference({
    prompt: enrichmentPrompt(req.sourceTitle, req.sourceText),
    model: GBRAIN_INGEST_INFERENCE_MODEL,
    runner: req.runner,
    signal: req.signal,
  });
  const extracted = validateEnrichmentOutput(response.text, { allowPartial: req.allowPartial });
  const nameToSlug = new Map<string, string>();
  const updated = new Set<string>();
  let skipped = 0;

  for (const kind of ['people', 'organizations', 'concepts'] as EntityKind[]) {
    for (const entity of extracted[kind]) {
      const slug = await upsertEntity(req.engine, kind, entity, req.sourceSlug);
      nameToSlug.set(entity.name.toLowerCase(), slug);
      updated.add(slug);
    }
  }

  for (const rel of extracted.relationships) {
    const from = nameToSlug.get(rel.from.toLowerCase());
    const to = nameToSlug.get(rel.to.toLowerCase());
    if (!from || !to) { skipped++; continue; }
    await req.engine.addLink(from, to, rel.citation, rel.type || 'related', 'manual');
  }

  const timelineTarget = Array.from(updated).find(slug => slug.startsWith('concepts/')) ?? req.sourceSlug;
  for (const entry of extracted.timeline) {
    await req.engine.addTimelineEntry(timelineTarget, {
      date: entry.date,
      summary: entry.summary,
      source: `${req.sourceSlug}: ${entry.citation}`,
    });
  }

  return {
    status: updated.size > 0 || extracted.timeline.length > 0 ? 'enriched' : 'skipped',
    updated_slugs: Array.from(updated),
    skipped,
  };
}

export function summarizeSuccessfulEnrichment(result: EnrichAcceptedSourceResult): BoundedEnrichmentResult {
  return {
    status: result.status === 'enriched' ? 'succeeded' : 'skipped',
    raw_status: result.status,
    updated_slugs: result.updated_slugs,
    skipped: result.skipped,
  };
}

export function summarizeFailedEnrichment(error: unknown): BoundedEnrichmentResult {
  if (error instanceof CodexOAuthInferenceError) {
    if (error.code === 'timeout') {
      return {
        status: 'timeout',
        error_code: error.code,
        message: 'Codex OAuth enrichment timed out',
      };
    }
    if (error.code === 'configuration_error' || error.code === 'oauth_unavailable' || error.code === 'model_rejected') {
      return {
        status: 'configuration_error',
        error_code: error.code,
        message: 'Codex OAuth enrichment is unavailable or misconfigured',
      };
    }
    return {
      status: 'failed',
      error_code: error.code,
      message: 'Codex OAuth enrichment failed',
    };
  }
  return {
    status: 'failed',
    error_code: 'enrichment_failed',
    message: 'GBrain enrichment failed',
  };
}
