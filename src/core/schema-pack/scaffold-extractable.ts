/**
 * v0.42 Wave C1 — `gbrain schema scaffold-extractable` mutation primitive.
 *
 * Generates everything a pack author needs to declare a new extractable
 * page type with the pack-supplied prompt + fixture-corpus + eval-dimensions
 * authoring loop:
 *
 *   1. Updates the pack's type to carry the v0.42 ExtractableSpec struct
 *      shape (prompt_template path + fixture_corpus path + eval_dimensions
 *      stub array). Reuses the proven `updateTypeOnPack` mutation skeleton
 *      so we inherit atomic write + per-pack lock + audit + cache
 *      invalidation for free.
 *
 *   2. Writes `<pack-root>/prompts/extract/<type>.md` with a recommended
 *      prompt template the pack author can edit. Falls back to a generic
 *      facts-style prompt; pack-author customizes.
 *
 *   3. Writes `<pack-root>/fixtures/extract/<type>.jsonl` with 5 placeholder
 *      fixtures (per CLAUDE.md privacy rule: alice-example, widget-co-example,
 *      etc.) so the pack-author can run `gbrain extract benchmark` immediately
 *      and iterate from a working baseline rather than an empty file.
 *
 * Refuses to overwrite existing prompt / fixture files — the mutation is
 * additive. Re-running with `--force` overwrites only the files (the YAML
 * mutation is naturally idempotent for the struct shape).
 *
 * Per plan D-EXTRACT-21: fixture path validation IS happening at the
 * `extract benchmark` consume site (canonicalize within pack root, reject
 * absolute paths / `..` / null bytes). This scaffolder generates only
 * relative paths, so it's compliant by construction.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { MutateResult } from './mutate.ts';
import {
  locateMutablePackFile,
  updateTypeOnPack,
  SchemaPackMutationError,
} from './mutate.ts';
import type { ExtractableSpec } from './manifest-v1.ts';

export interface ScaffoldExtractableOpts {
  /** Pack name (must be a writable pack — bundled packs are guarded). */
  packName: string;
  /** Page type to declare extractable on. */
  typeName: string;
  /**
   * v0.42 ExtractableSpec fields:
   *   - eval_dimensions: defaults to ['faithfulness', 'completeness'] when
   *     omitted — the two dimensions every LLM-backed extractor benefits
   *     from. Pack-author edits the manifest if their domain has a richer
   *     scoring rubric.
   */
  evalDimensions?: string[];
  /** Overwrite existing prompt + fixture files. Default false. */
  force?: boolean;
}

export interface ScaffoldExtractableResult {
  /** MutateResult from the underlying updateTypeOnPack call. */
  mutate: MutateResult;
  /** Absolute paths to files written this run. */
  filesWritten: string[];
  /** Paths skipped because they already existed and --force not set. */
  filesSkipped: string[];
}

/**
 * Pure helper: build the per-type prompt template body. Pack-authors
 * edit this after scaffold to specify their domain.
 */
export function buildPromptTemplate(typeName: string): string {
  return `# Extraction prompt for type \`${typeName}\`

You will be given the full body of a \`${typeName}\` page. Extract every
factual claim the page makes about its primary subject. Return STRICTLY a
JSON array of claim objects.

## Shape

Each claim is an object with these fields (all required unless marked
optional):

\`\`\`json
{
  "claim": "...",
  "since_date": "YYYY-MM-DD",
  "confidence": 0.0-1.0,
  "evidence_quote": "..."
}
\`\`\`

## Rules

- Extract only claims supported by direct evidence in the page body.
- Each \`evidence_quote\` MUST be a verbatim substring of the page body.
- \`since_date\` is the date the claim became true (or the page's effective
  date if no specific date is given).
- Confidence 1.0 = explicitly stated; 0.7 = strongly implied; below 0.6
  should usually be omitted.
- Return \`[]\` if the page contains no extractable claims.
- Do NOT speculate beyond the page body.

## Examples

(Placeholder examples — replace with real ones from your domain before
shipping this pack.)

Input page:
> alice-example founded widget-co-example in 2020 and raised a $5M seed
> in 2021.

Expected output:
\`\`\`json
[
  {
    "claim": "alice-example founded widget-co-example",
    "since_date": "2020-01-01",
    "confidence": 1.0,
    "evidence_quote": "alice-example founded widget-co-example in 2020"
  },
  {
    "claim": "widget-co-example raised a $5M seed",
    "since_date": "2021-01-01",
    "confidence": 1.0,
    "evidence_quote": "raised a $5M seed in 2021"
  }
]
\`\`\`
`;
}

/**
 * Pure helper: build the fixture corpus body (5 placeholder fixtures).
 * Each line is one JSON-serialized fixture per the `gbrain extract
 * benchmark` JSONL contract:
 *
 *   { fixture_id, page_body, expected_claims: [...], notes? }
 *
 * The 5 stubs cover the spread of inputs every pack-author needs to
 * handle: pure-claim, no-claim, ambiguous, edge-case, multi-claim.
 *
 * Per CLAUDE.md privacy rule: all placeholder names only.
 */
export function buildFixtureCorpus(typeName: string): string {
  const fixtures = [
    {
      fixture_id: `${typeName}-001-single-claim`,
      page_body:
        'alice-example founded widget-co-example in 2020.',
      expected_claims: [
        {
          claim: 'alice-example founded widget-co-example',
          since_date: '2020-01-01',
          confidence: 1.0,
        },
      ],
      notes: 'Baseline: one explicit factual claim.',
    },
    {
      fixture_id: `${typeName}-002-no-claim`,
      page_body:
        'This page is mostly placeholder text and contains no extractable claims.',
      expected_claims: [],
      notes: 'Negative case: extractor should return [].',
    },
    {
      fixture_id: `${typeName}-003-multi-claim`,
      page_body:
        'widget-co-example raised a $5M seed in 2021 and grew to 12 employees by mid-2022.',
      expected_claims: [
        {
          claim: 'widget-co-example raised a $5M seed',
          since_date: '2021-01-01',
          confidence: 1.0,
        },
        {
          claim: 'widget-co-example grew to 12 employees',
          since_date: '2022-06-01',
          confidence: 0.9,
        },
      ],
      notes: 'Two claims in one sentence.',
    },
    {
      fixture_id: `${typeName}-004-ambiguous`,
      page_body:
        'fund-a may have led the seed round, though sources are inconsistent.',
      expected_claims: [
        {
          claim: 'fund-a may have led the seed round',
          since_date: '2021-01-01',
          confidence: 0.6,
        },
      ],
      notes: 'Confidence drops on hedged language.',
    },
    {
      fixture_id: `${typeName}-005-implicit-date`,
      page_body:
        'charlie-example was the second employee at acme-example.',
      expected_claims: [
        {
          claim: 'charlie-example was the second employee at acme-example',
          since_date: null,
          confidence: 1.0,
        },
      ],
      notes: 'No date in body — extractor falls back to page effective_date or null.',
    },
  ];

  return fixtures.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

/**
 * Pure helper: build the v0.42 ExtractableSpec struct that gets written
 * to the pack manifest's `extractable` field on the target type.
 */
export function buildExtractableSpec(opts: {
  typeName: string;
  evalDimensions?: string[];
}): ExtractableSpec {
  return {
    prompt_template: `prompts/extract/${opts.typeName}.md`,
    fixture_corpus: `fixtures/extract/${opts.typeName}.jsonl`,
    eval_dimensions: opts.evalDimensions ?? ['faithfulness', 'completeness'],
  };
}

/**
 * Main entry: scaffold the extractable + the supporting files.
 *
 * Returns the MutateResult from the YAML mutation plus a list of disk
 * files written or skipped (idempotent re-run reports the skipped files
 * so the operator sees the no-op clearly).
 *
 * Throws SchemaPackMutationError for any pack-layer failure (bundled
 * pack, missing pack, parse error). File-write failures throw raw Errors
 * with a paste-ready remediation hint.
 */
export async function scaffoldExtractable(
  opts: ScaffoldExtractableOpts,
): Promise<ScaffoldExtractableResult> {
  // Resolves the pack-root dir + asserts the pack is writable (bundled
  // packs throw PACK_READONLY).
  const located = locateMutablePackFile(opts.packName);
  const packRoot = dirname(located.path);

  // Build paths first so we can report them in the result even when the
  // YAML mutation runs first.
  const promptPath = join(packRoot, 'prompts', 'extract', `${opts.typeName}.md`);
  const fixturePath = join(packRoot, 'fixtures', 'extract', `${opts.typeName}.jsonl`);

  // YAML mutation first — failing here means nothing else changes.
  // updateTypeOnPack's patch shape accepts the struct directly.
  const spec = buildExtractableSpec({
    typeName: opts.typeName,
    evalDimensions: opts.evalDimensions,
  });
  const mutate = await updateTypeOnPack(opts.packName, {
    name: opts.typeName,
    patch: { extractable: spec },
  });

  // File writes — idempotent unless --force. Refuse-to-overwrite path
  // is the canonical gbrain scaffold posture (matches schema init,
  // skillpack scaffold, etc).
  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];

  mkdirSync(dirname(promptPath), { recursive: true });
  if (!existsSync(promptPath) || opts.force) {
    writeFileSync(promptPath, buildPromptTemplate(opts.typeName));
    filesWritten.push(promptPath);
  } else {
    filesSkipped.push(promptPath);
  }

  mkdirSync(dirname(fixturePath), { recursive: true });
  if (!existsSync(fixturePath) || opts.force) {
    writeFileSync(fixturePath, buildFixtureCorpus(opts.typeName));
    filesWritten.push(fixturePath);
  } else {
    filesSkipped.push(fixturePath);
  }

  return { mutate, filesWritten, filesSkipped };
}

// Re-export so consumers don't need to thread mutate.ts directly when
// catching the failure class.
export { SchemaPackMutationError };
