/**
 * gbrain atoms - atom maintenance commands.
 *
 * The first subcommand is a deterministic, no-spend concept-label backfill for
 * atom pages created before extract_atoms started writing frontmatter.concepts.
 * It uses only existing signals and never invents labels with an LLM.
 */

import type { BrainEngine } from '../core/engine.ts';
import { normalizeAtomConceptLabels } from '../core/cycle/extract-atoms.ts';

interface AtomConceptRow {
  id: number;
  slug: string;
  source_id: string;
  frontmatter: unknown;
  compiled_truth: string | null;
}

export interface BackfillAtomConceptsOpts {
  apply?: boolean;
  yes?: boolean;
  limit?: number;
  sourceId?: string;
}

export interface AtomConceptCandidate {
  id: number;
  slug: string;
  source_id: string;
  concepts: string[];
}

export interface BackfillAtomConceptsResult {
  dry_run: boolean;
  limit: number;
  source_id?: string;
  examined: number;
  candidates: AtomConceptCandidate[];
  updated: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function printHelp(): void {
  console.log(`gbrain atoms - atom maintenance.

Usage:
  gbrain atoms backfill-concepts [--dry-run] [--apply --yes] [--limit N] [--source-id ID] [--json]

Subcommands:
  backfill-concepts   Populate frontmatter.concepts on old atom pages from
                      existing deterministic signals only: concept_refs,
                      concept/concept_slug fields, tags/topics/keywords, and
                      [[concepts/...]] links in the atom body.

Safety:
  Defaults to --dry-run. Mutations require both --apply and --yes.
  --limit caps the selected atom rows per run (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).
`);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function collectValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.flatMap(collectValues);
  if (typeof raw === 'string') return [raw];
  return [];
}

function candidateToLabel(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith('#')) value = value.slice(1);
  const aliasIndex = value.indexOf('|');
  if (aliasIndex >= 0) value = value.slice(0, aliasIndex);
  value = value.replace(/^wiki:/, '');
  if (value.startsWith('concepts/')) {
    value = value.split('/').filter(Boolean).pop() ?? value;
  }
  const normalized = normalizeAtomConceptLabels([value])[0];
  return normalized ?? null;
}

function extractConceptLinks(body: string | null): string[] {
  if (!body) return [];
  const out: string[] = [];
  const re = /\[\[\s*(?:wiki:)?concepts\/([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\s*\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    out.push(match[1]);
  }
  return out;
}

export function deriveAtomConceptLabels(frontmatter: unknown, body: string | null): string[] {
  const fm = asRecord(frontmatter);
  const rawValues = [
    ...collectValues(fm.concept_refs),
    ...collectValues(fm.concept_ref),
    ...collectValues(fm.concepts_legacy),
    ...collectValues(fm.concept_slugs),
    ...collectValues(fm.concept_slug),
    ...collectValues(fm.concepts_old),
    ...collectValues(fm.concept),
    ...collectValues(fm.tags),
    ...collectValues(fm.topics),
    ...collectValues(fm.keywords),
    ...extractConceptLinks(body),
  ];

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    const label = candidateToLabel(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= 5) break;
  }
  return labels;
}

async function loadCandidateRows(
  engine: BrainEngine,
  opts: { limit: number; sourceId?: string },
): Promise<AtomConceptRow[]> {
  const params: unknown[] = [];
  let sourceFilter = '';
  if (opts.sourceId) {
    params.push(opts.sourceId);
    sourceFilter = `AND source_id = $${params.length}`;
  }
  params.push(opts.limit);
  const limitParam = `$${params.length}`;

  return engine.executeRaw<AtomConceptRow>(
    `SELECT id, slug, source_id, frontmatter, compiled_truth
       FROM pages
      WHERE type = 'atom'
        AND deleted_at IS NULL
        ${sourceFilter}
        AND NOT COALESCE((
          jsonb_typeof(frontmatter->'concepts') = 'array'
          AND jsonb_array_length(frontmatter->'concepts') > 0
        ), false)
      ORDER BY id
      LIMIT ${limitParam}`,
    params,
  );
}

export async function backfillAtomConcepts(
  engine: BrainEngine,
  opts: BackfillAtomConceptsOpts = {},
): Promise<BackfillAtomConceptsResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const dryRun = opts.apply !== true;
  if (!dryRun && opts.yes !== true) {
    throw new Error('Refusing to mutate atom concepts without --yes. Preview with --dry-run --json first.');
  }

  const rows = await loadCandidateRows(engine, { limit, sourceId: opts.sourceId });
  const candidates: AtomConceptCandidate[] = [];
  for (const row of rows) {
    const concepts = deriveAtomConceptLabels(row.frontmatter, row.compiled_truth);
    if (concepts.length === 0) continue;
    candidates.push({ id: row.id, slug: row.slug, source_id: row.source_id, concepts });
  }

  let updated = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      await engine.executeRaw(
        `UPDATE pages
            SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || $2::text::jsonb
          WHERE id = $1`,
        [candidate.id, JSON.stringify({ concepts: candidate.concepts })],
      );
      updated++;
    }
  }

  return {
    dry_run: dryRun,
    limit,
    ...(opts.sourceId && { source_id: opts.sourceId }),
    examined: rows.length,
    candidates,
    updated,
  };
}

function parseBackfillConceptsArgs(args: string[]): BackfillAtomConceptsOpts & { json?: boolean } {
  const apply = args.includes('--apply');
  return {
    apply,
    yes: args.includes('--yes'),
    limit: parseLimit(flagValue(args, '--limit')),
    sourceId: flagValue(args, '--source-id'),
    json: args.includes('--json'),
  };
}

export async function runAtoms(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (sub !== 'backfill-concepts') {
    console.error(`Unknown atoms subcommand: ${sub}`);
    printHelp();
    process.exit(2);
  }

  const opts = parseBackfillConceptsArgs(args.slice(1));
  const result = await backfillAtomConcepts(engine, opts);
  if (opts.json) {
    console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
    return;
  }

  const prefix = result.dry_run ? '[dry-run] ' : '';
  console.log(`${prefix}atom concept backfill: ${result.candidates.length} candidate(s), ${result.updated} updated, examined=${result.examined}, limit=${result.limit}`);
  for (const candidate of result.candidates.slice(0, 10)) {
    console.log(`  ${candidate.slug}: ${candidate.concepts.join(', ')}`);
  }
  if (result.candidates.length > 10) {
    console.log(`  ... ${result.candidates.length - 10} more`);
  }
}
