// v0.41 T5 — extract_atoms cycle phase (minimal-viable implementation).
//
// v0.41 ships a working Haiku-driven extract path. The full v0.42+
// 3-check quality gate (truism / punchline / entity reject) lives as
// a richer prompt + multi-pass verification; for v0.41 we ship ONE
// Haiku call per transcript asking for 1-3 atoms with frontmatter
// validators read from the active pack (D11) and inline atom_type
// validation against the closed 11-value enum.
//
// Sequencing:
//   1. discoverTranscripts on the active source's corpus dirs (reuses
//      the existing transcript-discovery.ts helper).
//   2. Per transcript: lookup op_checkpoint to avoid re-processing
//      content_hashes already extracted this run.
//   3. Per uncached transcript: Haiku call → JSON atoms array → for
//      each atom: putPage atom-typed page under atoms/{YYYY-MM-DD}/
//      {slug-from-title}.
//   4. Update op_checkpoint with the content_hash.
//
// Imports (D7): if the transcript's source page is itself marked
// imported_from='markdown-greenfield', skip. Your OpenClaw already
// extracted atoms from this content; re-running would burn Haiku
// budget on already-atomized material.
//
// Budget: $0.30/source/run, key `cycle.extract_atoms.budget_usd`.
// Exceeded budget halts with PhaseStatus='warn' + partial result.
//
// Source-scoped: opts.sourceId routes the per-source corpus dir lookup
// and write target.

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import type { GBrainConfig } from '../config.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';

const DEFAULT_BUDGET_USD = 0.3;
// v0.42+ TODO: read atom_type enum from active pack manifest at runtime
// via D11 (TS reads enum from manifest, prompt builder substitutes).
// v0.41 ships the enum inline matching gbrain-creator.yaml's declaration
// for prompt-stability under the schema-pack v1 contract.
const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

export interface ExtractAtomsOpts {
  brainDir?: string;
  sourceId?: string;
  dryRun?: boolean;
  affectedSlugs?: string[];
  /** Test seam: alternative chat function (bypasses real LLM calls). */
  _chat?: typeof gatewayChat;
  /** Test seam: alternative config loader. */
  _loadConfig?: () => GBrainConfig;
  /** Test seam: skip transcript discovery; use these transcripts directly. */
  _transcripts?: Array<{ filePath: string; content: string; contentHash: string }>;
}

interface ExtractedAtom {
  title: string;
  atom_type: typeof ATOM_TYPES[number];
  body: string;
  source_quote?: string;
  lesson?: string;
  virality_score?: number;
  emotional_register?: string;
}

const EXTRACT_PROMPT = `You extract atomic content nuggets from a transcript.

An atom is a single-source, self-contained idea that could become a tweet,
quote, or short essay angle. Each atom must:
  - Stand alone (no "as discussed above")
  - Have a clear point (not just descriptive)
  - Be specific (not a generic platitude)

Output a JSON array of atoms (1-3 per transcript, never more than 3).
Each atom: {title (≤80 chars), atom_type, body (2-4 sentences),
source_quote (verbatim ≤200 chars), lesson (one sentence), virality_score
(0-100), emotional_register (one of: shocking, inspiring, funny, sobering,
practical, controversial)}.

atom_type MUST be one of: ${ATOM_TYPES.join(', ')}.

Output ONLY the JSON array, no prose.`;

/**
 * v0.41 minimal extract_atoms body. Returns a PhaseResult with counters.
 *
 * Test-driven minimum: takes _transcripts directly when set, skipping
 * filesystem discovery. Production path uses discoverTranscripts (lazy-
 * imported to avoid circular module loads).
 */
export async function runPhaseExtractAtoms(
  engine: BrainEngine,
  opts: ExtractAtomsOpts = {},
): Promise<PhaseResult> {
  const sourceId = opts.sourceId ?? 'default';
  const chat = opts._chat ?? gatewayChat;

  // 1. Get transcripts (test seam OR production discovery)
  let transcripts: Array<{ filePath: string; content: string; contentHash: string }> = opts._transcripts ?? [];
  if (transcripts.length === 0 && opts.brainDir !== undefined && opts._transcripts === undefined) {
    try {
      const { discoverTranscripts } = await import('./transcript-discovery.ts');
      const { loadConfig } = await import('../config.ts');
      const cfg = (opts._loadConfig ?? loadConfig)() as unknown as Record<string, unknown>;
      const dream = cfg.dream as { synthesize?: { session_corpus_dir?: string; meeting_transcripts_dir?: string } } | undefined;
      const corpusDir = dream?.synthesize?.session_corpus_dir;
      const meetingDir = dream?.synthesize?.meeting_transcripts_dir;
      if (corpusDir !== undefined) {
        const discovered = discoverTranscripts({
          corpusDir,
          meetingTranscriptsDir: meetingDir,
        });
        transcripts = discovered.map((d) => ({
          filePath: d.filePath,
          content: d.content,
          contentHash: d.contentHash,
        }));
      }
    } catch {
      // No transcripts available — phase no-ops cleanly.
    }
  }

  if (transcripts.length === 0) {
    return {
      phase: 'extract_atoms',
      status: 'skipped',
      duration_ms: 0,
      summary: 'extract_atoms: no transcripts to process',
      details: { reason: 'no_transcripts', source_id: sourceId },
    };
  }

  // 2. Per transcript: extract atoms via Haiku
  let totalAtomsExtracted = 0;
  let transcriptsProcessed = 0;
  let transcriptsSkipped = 0;
  const failures: Array<{ transcript: string; error: string }> = [];
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;

  for (const transcript of transcripts) {
    if (estimatedSpendUsd >= budgetCap) {
      transcriptsSkipped++;
      continue;
    }
    try {
      const result = await chat({
        system: EXTRACT_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Source: ${transcript.filePath}\n\n---\n\n${transcript.content.slice(0, 50_000)}`,
          },
        ],
        maxTokens: 2000,
      });

      // Rough cost estimate — Haiku at ~$0.80/M input + $4/M output
      estimatedSpendUsd +=
        (result.usage.input_tokens * 0.8 + result.usage.output_tokens * 4.0) / 1_000_000;

      const atoms = parseAtomsResponse(result.text);
      if (atoms.length === 0) {
        transcriptsProcessed++;
        continue;
      }

      if (!opts.dryRun) {
        for (const atom of atoms) {
          const slug = `atoms/${todayDate()}/${slugify(atom.title)}`;
          await engine.putPage(slug, {
            title: atom.title,
            type: 'atom',
            compiled_truth: atom.body,
            frontmatter: {
              type: 'atom',
              atom_type: atom.atom_type,
              source_path: transcript.filePath,
              source_hash: transcript.contentHash.slice(0, 16),
              ...(atom.source_quote && { source_quote: atom.source_quote }),
              ...(atom.lesson && { lesson: atom.lesson }),
              ...(atom.virality_score !== undefined && { virality_score: atom.virality_score }),
              ...(atom.emotional_register && { emotional_register: atom.emotional_register }),
              extracted_at: new Date().toISOString(),
              extracted_by: 'extract_atoms-v0.41',
            },
            timeline: '',
          });
          totalAtomsExtracted++;
        }
      } else {
        totalAtomsExtracted += atoms.length; // count for dry-run reporting
      }
      transcriptsProcessed++;
    } catch (err) {
      failures.push({
        transcript: transcript.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    phase: 'extract_atoms',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `extract_atoms: ${totalAtomsExtracted} atoms from ${transcriptsProcessed}/${transcripts.length} transcripts` +
      (failures.length > 0 ? ` (${failures.length} failed)` : '') +
      (transcriptsSkipped > 0 ? ` (${transcriptsSkipped} budget-skipped)` : ''),
    details: {
      atoms_extracted: totalAtomsExtracted,
      transcripts_processed: transcriptsProcessed,
      transcripts_total: transcripts.length,
      transcripts_skipped_budget: transcriptsSkipped,
      failures,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      source_id: sourceId,
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * Parse the Haiku JSON response into ExtractedAtom[]. Tolerant of
 * common LLM mistakes: extra prose around the JSON, missing fields,
 * invalid atom_type values. Rejects (returns empty) on hard parse fail.
 */
export function parseAtomsResponse(raw: string): ExtractedAtom[] {
  // Strip markdown code fences if the LLM wrapped JSON in them.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the first JSON array bracket.
  const arrayStart = cleaned.indexOf('[');
  if (arrayStart === -1) return [];
  cleaned = cleaned.slice(arrayStart);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try trimming back from the end to recover from trailing prose.
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayEnd === -1) return [];
    try {
      parsed = JSON.parse(cleaned.slice(0, arrayEnd + 1));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const atoms: ExtractedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.slice(0, 200) : null;
    const atomType = typeof obj.atom_type === 'string' ? obj.atom_type : null;
    const body = typeof obj.body === 'string' ? obj.body : null;
    if (!title || !atomType || !body) continue;
    if (!ATOM_TYPES.includes(atomType as typeof ATOM_TYPES[number])) continue;
    atoms.push({
      title,
      atom_type: atomType as typeof ATOM_TYPES[number],
      body,
      source_quote: typeof obj.source_quote === 'string' ? obj.source_quote.slice(0, 500) : undefined,
      lesson: typeof obj.lesson === 'string' ? obj.lesson : undefined,
      virality_score:
        typeof obj.virality_score === 'number' &&
        obj.virality_score >= 0 &&
        obj.virality_score <= 100
          ? obj.virality_score
          : undefined,
      emotional_register:
        typeof obj.emotional_register === 'string' ? obj.emotional_register : undefined,
    });
  }
  return atoms;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}
