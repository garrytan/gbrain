/**
 * Cat 11 — Multi-modal ingestion fidelity.
 *
 * Measures text fidelity across three modalities:
 *
 *   - **PDF** (10 arXiv papers, CC-licensed): char-level similarity vs
 *     canonical .txt + entity recall. Threshold (informational): >0.95.
 *   - **Audio** (5 Common Voice CC0 clips): WER vs canonical .txt.
 *     Opt-in via `GROQ_API_KEY` or `OPENAI_API_KEY`. Threshold: <0.15.
 *   - **HTML** (10 Wikipedia snapshots, CC-BY-SA): prose word-recall vs
 *     canonical .txt. Threshold: >0.80.
 *
 * Image OCR + video deferred to Cat 11 v2. XLSX also deferred (use authored
 * markdown tables instead — codex flagged the xlsx parser dep as not worth
 * adding for v1).
 *
 * Fixtures are NOT committed to the repo. They download on demand via
 * `bun run eval:fetch-multimodal` using hash-verified manifests at
 * `eval/data/multimodal/<pdf|audio|html>/fixtures.json`. This keeps the
 * repo lean while preserving reproducibility.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { extractPdfText } from './loaders/pdf.ts';

// ─── Manifest types ──────────────────────────────────────────────────

export interface FixtureManifest {
  version: 1;
  license: string;
  items: Array<{
    name: string;
    path: string;
    canonical_path: string;
    sha256: string;
    /** For entity-recall scoring (PDF). Optional list of expected entity names. */
    entities?: string[];
  }>;
}

// ─── Per-modality results ────────────────────────────────────────────

export interface ModalityResult {
  modality: 'pdf' | 'audio' | 'html';
  items: number;
  items_attempted: number;
  /** Mean similarity / fidelity / recall for the modality. */
  mean_metric: number;
  /** Per-item breakdown. */
  per_item: Array<{
    name: string;
    metric: number;
    /** Optional — e.g., number of entities matched (PDF) or word-count (HTML). */
    detail?: Record<string, number>;
    error?: string;
  }>;
  /** True if the modality was skipped (e.g., missing fixtures or API key). */
  skipped: boolean;
  skip_reason?: string;
}

export interface Cat11Report {
  schema_version: 1;
  ran_at: string;
  results: Record<'pdf' | 'audio' | 'html', ModalityResult>;
  verdict: 'pass' | 'fail' | 'baseline_only' | 'skipped';
}

// ─── Char-level similarity (Levenshtein-based) ───────────────────────

/**
 * Char-level similarity using normalized Levenshtein edit distance.
 * Returns 0..1 where 1 = exact match. O(n*m) memory — fine for PDF/HTML
 * comparisons capped at ~100KB each.
 */
export function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const n = a.length;
  const m = b.length;
  // Use typed arrays for speed on larger strings
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  const distance = prev[m];
  const maxLen = Math.max(n, m);
  return 1 - distance / maxLen;
}

// ─── Word-level recall (for HTML) ────────────────────────────────────

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

/**
 * Word recall: fraction of canonical words present in extracted text.
 * Multiset semantics: if canonical has "the the the" and extracted has "the",
 * recall is 1/3.
 */
export function wordRecall(canonical: string, extracted: string): number {
  const canonicalWords = normalizeWords(canonical);
  const extractedCounts = new Map<string, number>();
  for (const w of normalizeWords(extracted)) {
    extractedCounts.set(w, (extractedCounts.get(w) ?? 0) + 1);
  }
  if (canonicalWords.length === 0) return 1;
  let hits = 0;
  for (const w of canonicalWords) {
    const count = extractedCounts.get(w) ?? 0;
    if (count > 0) {
      hits++;
      extractedCounts.set(w, count - 1);
    }
  }
  return hits / canonicalWords.length;
}

// ─── WER (word error rate) for audio ─────────────────────────────────

/**
 * Word Error Rate: Levenshtein distance at word level / reference word count.
 * Lower is better. 0.0 = perfect transcription. Typical whisper-v3 on clean
 * English ≈ 0.05-0.10.
 */
export function wer(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

  const n = ref.length;
  const m = hyp.length;
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m] / n;
}

// ─── PDF modality ─────────────────────────────────────────────────────

export async function runPdfModality(
  fixturesDir: string = resolve(process.cwd(), 'eval/data/multimodal/pdf'),
): Promise<ModalityResult> {
  const manifestPath = join(fixturesDir, 'fixtures.json');
  if (!existsSync(manifestPath)) {
    return {
      modality: 'pdf',
      items: 0,
      items_attempted: 0,
      mean_metric: 0,
      per_item: [],
      skipped: true,
      skip_reason: `No manifest at ${manifestPath}. Run \`bun run eval:fetch-multimodal\` first.`,
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  const perItem: ModalityResult['per_item'] = [];
  let metricSum = 0;
  let attempted = 0;

  for (const item of manifest.items) {
    const pdfPath = join(fixturesDir, item.path);
    const canonicalPath = join(fixturesDir, item.canonical_path);
    if (!existsSync(pdfPath) || !existsSync(canonicalPath)) {
      perItem.push({
        name: item.name,
        metric: 0,
        error: `missing fixture file(s) at ${item.path} / ${item.canonical_path}`,
      });
      continue;
    }
    try {
      const extracted = await extractPdfText(pdfPath);
      const canonical = readFileSync(canonicalPath, 'utf8');
      const similarity = charSimilarity(canonical.trim(), extracted.text.trim());

      // Entity recall if the manifest declares expected entities
      let entityRecall: number | undefined;
      if (item.entities && item.entities.length > 0) {
        const hits = item.entities.filter(name =>
          extracted.text.toLowerCase().includes(name.toLowerCase()),
        ).length;
        entityRecall = hits / item.entities.length;
      }

      perItem.push({
        name: item.name,
        metric: similarity,
        detail: {
          num_pages: extracted.numPages,
          canonical_chars: canonical.length,
          extracted_chars: extracted.text.length,
          ...(entityRecall !== undefined ? { entity_recall: entityRecall } : {}),
        },
      });
      metricSum += similarity;
      attempted++;
    } catch (err) {
      perItem.push({ name: item.name, metric: 0, error: String(err) });
    }
  }

  return {
    modality: 'pdf',
    items: manifest.items.length,
    items_attempted: attempted,
    mean_metric: attempted === 0 ? 0 : metricSum / attempted,
    per_item: perItem,
    skipped: false,
  };
}

// ─── HTML modality ────────────────────────────────────────────────────

/**
 * Strip HTML tags + common noise, collapse whitespace. Not a full HTML
 * parser — intentionally simple to make the metric stable across HTML
 * variations.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runHtmlModality(
  fixturesDir: string = resolve(process.cwd(), 'eval/data/multimodal/html'),
): Promise<ModalityResult> {
  const manifestPath = join(fixturesDir, 'fixtures.json');
  if (!existsSync(manifestPath)) {
    return {
      modality: 'html',
      items: 0,
      items_attempted: 0,
      mean_metric: 0,
      per_item: [],
      skipped: true,
      skip_reason: `No manifest at ${manifestPath}.`,
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  const perItem: ModalityResult['per_item'] = [];
  let metricSum = 0;
  let attempted = 0;

  for (const item of manifest.items) {
    const htmlPath = join(fixturesDir, item.path);
    const canonicalPath = join(fixturesDir, item.canonical_path);
    if (!existsSync(htmlPath) || !existsSync(canonicalPath)) {
      perItem.push({
        name: item.name,
        metric: 0,
        error: `missing fixture file(s)`,
      });
      continue;
    }
    try {
      const html = readFileSync(htmlPath, 'utf8');
      const canonical = readFileSync(canonicalPath, 'utf8');
      const extracted = htmlToText(html);
      const recall = wordRecall(canonical, extracted);
      perItem.push({
        name: item.name,
        metric: recall,
        detail: {
          canonical_chars: canonical.length,
          extracted_chars: extracted.length,
        },
      });
      metricSum += recall;
      attempted++;
    } catch (err) {
      perItem.push({ name: item.name, metric: 0, error: String(err) });
    }
  }

  return {
    modality: 'html',
    items: manifest.items.length,
    items_attempted: attempted,
    mean_metric: attempted === 0 ? 0 : metricSum / attempted,
    per_item: perItem,
    skipped: false,
  };
}

// ─── Audio modality ──────────────────────────────────────────────────

export interface AudioRunOpts {
  /** Injectable transcriber for tests. Default uses src/core/transcription.ts. */
  transcribe?: (audioPath: string) => Promise<{ text: string; provider: string }>;
}

export async function runAudioModality(
  fixturesDir: string = resolve(process.cwd(), 'eval/data/multimodal/audio'),
  opts: AudioRunOpts = {},
): Promise<ModalityResult> {
  const manifestPath = join(fixturesDir, 'fixtures.json');
  if (!existsSync(manifestPath)) {
    return {
      modality: 'audio',
      items: 0,
      items_attempted: 0,
      mean_metric: 0,
      per_item: [],
      skipped: true,
      skip_reason: `No manifest at ${manifestPath}.`,
    };
  }

  // Gate on API keys unless a test-injected transcriber is provided.
  const hasApiKey = !!process.env.GROQ_API_KEY || !!process.env.OPENAI_API_KEY;
  if (!opts.transcribe && !hasApiKey) {
    return {
      modality: 'audio',
      items: 0,
      items_attempted: 0,
      mean_metric: 0,
      per_item: [],
      skipped: true,
      skip_reason: 'Neither GROQ_API_KEY nor OPENAI_API_KEY is set; audio transcription requires one.',
    };
  }

  const transcriber = opts.transcribe ?? (await loadDefaultTranscriber());

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  const perItem: ModalityResult['per_item'] = [];
  let metricSum = 0;
  let attempted = 0;

  for (const item of manifest.items) {
    const audioPath = join(fixturesDir, item.path);
    const canonicalPath = join(fixturesDir, item.canonical_path);
    if (!existsSync(audioPath) || !existsSync(canonicalPath)) {
      perItem.push({ name: item.name, metric: 1, error: 'missing fixture file(s)' });
      continue;
    }
    try {
      const { text, provider } = await transcriber(audioPath);
      const canonical = readFileSync(canonicalPath, 'utf8');
      const errorRate = wer(canonical, text);
      perItem.push({
        name: item.name,
        metric: errorRate,
        detail: {
          canonical_words: normalizeWords(canonical).length,
          transcribed_words: normalizeWords(text).length,
          provider_length: provider.length,
        },
      });
      metricSum += errorRate;
      attempted++;
    } catch (err) {
      perItem.push({ name: item.name, metric: 1, error: String(err) });
    }
  }

  return {
    modality: 'audio',
    items: manifest.items.length,
    items_attempted: attempted,
    mean_metric: attempted === 0 ? 0 : metricSum / attempted,
    per_item: perItem,
    skipped: false,
  };
}

async function loadDefaultTranscriber(): Promise<NonNullable<AudioRunOpts['transcribe']>> {
  // Lazy import src/core/transcription.ts so this file doesn't drag that
  // import into module-load time. transcription.ts has env checks that
  // throw if GROQ/OPENAI keys are absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('../../src/core/transcription.ts');
  const fn = mod.transcribe ?? mod.default;
  if (typeof fn !== 'function') {
    throw new Error('src/core/transcription.ts does not export a transcribe function');
  }
  return async (audioPath: string) => {
    const res = await fn(audioPath);
    return { text: res.text ?? '', provider: res.provider ?? 'unknown' };
  };
}

// ─── Runner entry ─────────────────────────────────────────────────────

export interface RunCat11Options {
  fixturesRoot?: string;
  /** Override the audio transcriber (test injection). */
  transcribeAudio?: AudioRunOpts['transcribe'];
}

export async function runCat11(opts: RunCat11Options = {}): Promise<Cat11Report> {
  const root = opts.fixturesRoot ?? resolve(process.cwd(), 'eval/data/multimodal');
  const [pdf, html, audio] = await Promise.all([
    runPdfModality(join(root, 'pdf')),
    runHtmlModality(join(root, 'html')),
    runAudioModality(join(root, 'audio'), { transcribe: opts.transcribeAudio }),
  ]);

  const anyRan = !pdf.skipped || !html.skipped || !audio.skipped;

  return {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    results: { pdf, html, audio },
    verdict: anyRan ? 'baseline_only' : 'skipped',
  };
}

if (import.meta.main) {
  runCat11()
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
