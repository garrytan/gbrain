/**
 * v0.28: `gbrain think` — INTENT → GATHER → SYNTHESIZE → (optional) COMMIT.
 *
 * v0.28.0 ships the full pipeline. The Anthropic call is dependency-injected
 * (MessagesClient interface) so tests can stub it without an API key. Live
 * runs require ANTHROPIC_API_KEY in the environment.
 *
 * --rounds scaffolding: round 1 is the only round actually exercised in
 * v0.28. Round N+1 fed by gaps from round N is the v0.29 follow-up; the
 * loop structure is in place so rounds > 1 don't fail — they just re-run
 * gather + synthesize without specialized gap-filling logic. Use rounds=1
 * (the default) for production until the gap-fill heuristic ships.
 *
 * --save persists a synthesis page + synthesis_evidence rows. --take
 * appends a take row to the anchor page (requires --anchor). Both are
 * local-CLI-only; remote (MCP) callers get a `not_implemented` envelope
 * for those flags per Codex P1 #7.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BrainEngine, SynthesisEvidenceInput } from '../engine.ts';
import { runGather, renderPagesBlock, takesHitToTakeForPrompt } from './gather.ts';
import { renderTakesBlock } from './sanitize.ts';
import { buildThinkSystemPrompt, buildThinkUserMessage } from './prompt.ts';
import { resolveCitations, type ParsedCitation } from './cite-render.ts';
import { resolveModel } from '../model-config.ts';

/** Anthropic Messages client interface — same shape used by subagent.ts so test stubs can be shared. */
export interface ThinkLLMClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export interface RunThinkOpts {
  question: string;
  /** Anchor entity slug. Activates the graph stream + entity-focused prompt. */
  anchor?: string;
  /** v0.28: rounds=1 is the only path exercised. Round-loop scaffolding is in place. */
  rounds?: number;
  /** When true, persist a synthesis page (caller resolves brainDir externally if writing to disk). */
  save?: boolean;
  /** When true, append a take row to the anchor page (requires anchor). */
  take?: boolean;
  /** Model override (CLI flag). Falls through resolveModel's 6-tier chain. */
  model?: string;
  /** Optional time window for temporal questions. */
  since?: string;
  until?: string;
  /** When set, MCP-bound calls forward this to the gather phase (server-side filter). */
  takesHoldersAllowList?: string[];
  /** Inject an LLM client (for tests). Defaults to a fresh Anthropic SDK client. */
  client?: ThinkLLMClient;
  /** Inject a question-embedding function. When omitted, vector takes search is skipped. */
  embedQuestion?: (q: string) => Promise<Float32Array | null>;
  /** Pure-test escape: return synthesized payload without calling any LLM. */
  stubResponse?: ThinkResponse;
}

/** Structured response from the LLM (matches the schema declared in prompt.ts). */
export interface ThinkResponse {
  answer: string;
  citations: Array<{ page_slug: string; row_num: number | null; citation_index?: number }>;
  gaps: string[];
}

export interface ThinkResult {
  question: string;
  answer: string;
  citations: ParsedCitation[];
  gaps: string[];
  pagesGathered: number;
  takesGathered: number;
  graphHits: number;
  modelUsed: string;
  rounds: number;
  warnings: string[];
  /** Only set when --save was true and the caller persisted a synthesis page. */
  savedSlug?: string;
  /** Diagnostics for `--explain` callers (CLI surface for v0.29). */
  diagnostics: {
    pagesFromHybrid: number;
    takesFromKeyword: number;
    takesFromVector: number;
    graphHits: number;
  };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

function inferIntent(question: string, anchor?: string): string {
  if (anchor) return 'entity';
  const q = question.toLowerCase();
  if (/\b(when|history|over time|evolved|since|before|after)\b/.test(q)) return 'temporal';
  if (/\b(meeting|event|happened)\b/.test(q)) return 'event';
  return 'general';
}

function tryParseJSON(text: string): unknown {
  // The model may wrap JSON in code fences. Strip if present.
  const stripped = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    // Fallback: extract the first {...} block. Useful when the model emits prose alongside JSON.
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
    return null;
  }
}

/**
 * Persist citations into synthesis_evidence. Resolves slugs to page_ids
 * via the engine. Pages that don't exist in the brain are skipped + warn'd.
 * Pages without a row_num are page-level citations and are NOT persisted
 * (synthesis_evidence is a take→synthesis FK; page-level citations live in
 * the answer body's [slug] markers only).
 */
async function persistCitations(
  engine: BrainEngine,
  synthesisPageId: number,
  citations: ParsedCitation[],
): Promise<{ inserted: number; warnings: string[] }> {
  const warnings: string[] = [];
  // Resolve unique slugs to page_ids
  const slugToPageId = new Map<string, number>();
  for (const c of citations) {
    if (c.row_num === null) continue;  // page-level, skip
    if (slugToPageId.has(c.page_slug)) continue;
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
      [c.page_slug],
    );
    if (rows[0]) slugToPageId.set(c.page_slug, rows[0].id);
  }
  const evidenceInputs: SynthesisEvidenceInput[] = [];
  for (const c of citations) {
    if (c.row_num === null) continue;
    const pageId = slugToPageId.get(c.page_slug);
    if (!pageId) {
      warnings.push(`CITATION_PAGE_NOT_IN_BRAIN: ${c.page_slug}#${c.row_num}`);
      continue;
    }
    evidenceInputs.push({
      synthesis_page_id: synthesisPageId,
      take_page_id: pageId,
      take_row_num: c.row_num,
      citation_index: c.citation_index,
    });
  }
  if (evidenceInputs.length === 0) return { inserted: 0, warnings };
  const inserted = await engine.addSynthesisEvidence(evidenceInputs);
  return { inserted, warnings };
}

/**
 * Run the think pipeline. Returns a ThinkResult — caller decides whether
 * to print, persist as synthesis page, or surface as MCP response.
 */
export async function runThink(
  engine: BrainEngine,
  opts: RunThinkOpts,
): Promise<ThinkResult> {
  const rounds = Math.max(1, opts.rounds ?? 1);
  const warnings: string[] = [];

  // Resolve the model through the 6-tier chain.
  const modelUsed = await resolveModel(engine, {
    cliFlag: opts.model,
    configKey: 'models.think',
    fallback: 'opus',  // think is the high-stakes synthesis op; opus is the right default
  });

  // Optional question embedding — caller decides whether to pay the embedder.
  let questionEmbedding: Float32Array | undefined;
  if (opts.embedQuestion) {
    try {
      const e = await opts.embedQuestion(opts.question);
      if (e) questionEmbedding = e;
    } catch (e) {
      warnings.push(`QUESTION_EMBED_FAILED: ${(e as Error).message}`);
    }
  }

  // GATHER
  const gather = await runGather(engine, {
    question: opts.question,
    anchor: opts.anchor,
    questionEmbedding,
    takesHoldersAllowList: opts.takesHoldersAllowList,
  });

  // Render evidence blocks for the prompt
  const pagesBlock = renderPagesBlock(gather.pages);
  const takesForPrompt = gather.takes.map(takesHitToTakeForPrompt);
  const { rendered: takesBlock, sanitizedCount } = renderTakesBlock(takesForPrompt);
  if (sanitizedCount > 0) {
    warnings.push(`SANITIZED_${sanitizedCount}_TAKE_CLAIMS`);
  }
  const graphBlock = gather.graphSlugs.length > 0
    ? `<anchor>${opts.anchor}</anchor>\nReachable: ${gather.graphSlugs.slice(0, 30).join(', ')}`
    : undefined;

  // SYNTHESIZE
  const intent = inferIntent(opts.question, opts.anchor);
  const systemPrompt = buildThinkSystemPrompt({
    intent,
    anchor: opts.anchor,
    since: opts.since,
    until: opts.until,
    willSave: opts.save,
  });
  const userMessage = buildThinkUserMessage({
    question: opts.question,
    pagesBlock,
    takesBlock,
    graphBlock,
  });

  let response: ThinkResponse;
  if (opts.stubResponse) {
    response = opts.stubResponse;
  } else {
    if (!opts.client && !process.env.ANTHROPIC_API_KEY) {
      warnings.push('NO_ANTHROPIC_API_KEY');
      // Degrade gracefully: return the gather without synthesis. Better than throwing.
      return {
        question: opts.question,
        answer: '(no LLM available — set ANTHROPIC_API_KEY or pass `client`)',
        citations: [],
        gaps: ['no LLM available; gather succeeded but synthesis skipped'],
        pagesGathered: gather.pages.length,
        takesGathered: gather.takes.length,
        graphHits: gather.graphSlugs.length,
        modelUsed,
        rounds: 0,
        warnings,
        diagnostics: {
          pagesFromHybrid: gather.diagnostics.pagesFromHybrid,
          takesFromKeyword: gather.diagnostics.takesFromKeyword,
          takesFromVector: gather.diagnostics.takesFromVector,
          graphHits: gather.diagnostics.graphHits,
        },
      };
    }
    // Anthropic SDK exposes the create method via .messages — match the structural signature.
    const realClient = new Anthropic();
    const client: ThinkLLMClient = opts.client ?? {
      create: (params, opts2) => realClient.messages.create(params, opts2),
    };
    const result = await client.create({
      model: modelUsed,
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = result.content.find(b => b.type === 'text');
    const text = block && 'text' in block ? block.text : '';
    const parsed = tryParseJSON(text);
    if (!parsed || typeof parsed !== 'object') {
      warnings.push('LLM_OUTPUT_NOT_JSON');
      response = { answer: text, citations: [], gaps: [] };
    } else {
      const r = parsed as Partial<ThinkResponse>;
      response = {
        answer: typeof r.answer === 'string' ? r.answer : '',
        citations: Array.isArray(r.citations) ? (r.citations as ThinkResponse['citations']) : [],
        gaps: Array.isArray(r.gaps) ? (r.gaps as string[]).filter(g => typeof g === 'string') : [],
      };
    }
  }

  // Resolve citations: prefer structured, fall back to inline-marker regex scan.
  const resolved = resolveCitations(response.citations, response.answer);
  if (resolved.warnings.length > 0) {
    for (const w of resolved.warnings) warnings.push(w);
  }

  // Round-loop scaffolding (rounds > 1 currently re-runs without gap-driven retrieval).
  // The loop is in place so the v0.29 gap-fill heuristic doesn't change the call site.
  for (let r = 1; r < rounds; r++) {
    warnings.push(`ROUNDS_GT_1_NOT_GAP_DRIVEN_IN_V028`);
    break;  // v0.28: single-pass only
  }

  return {
    question: opts.question,
    answer: response.answer,
    citations: resolved.citations,
    gaps: response.gaps,
    pagesGathered: gather.pages.length,
    takesGathered: gather.takes.length,
    graphHits: gather.graphSlugs.length,
    modelUsed,
    rounds: 1,
    warnings,
    diagnostics: {
      pagesFromHybrid: gather.diagnostics.pagesFromHybrid,
      takesFromKeyword: gather.diagnostics.takesFromKeyword,
      takesFromVector: gather.diagnostics.takesFromVector,
      graphHits: gather.diagnostics.graphHits,
    },
  };
}

/**
 * Persist a synthesis page + its evidence. Returns the saved slug.
 * Synthesis pages are written under `synthesis/<slugified-question>-<date>.md`.
 */
export async function persistSynthesis(
  engine: BrainEngine,
  result: ThinkResult,
): Promise<{ slug: string; evidenceInserted: number; warnings: string[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const slugSafe = result.question
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'untitled';
  const slug = `synthesis/${slugSafe}-${today}`;

  // Build the markdown body
  const body = [
    `# ${result.question}`,
    '',
    result.answer,
    '',
    result.gaps.length > 0 ? '## Gaps\n\n' + result.gaps.map(g => `- ${g}`).join('\n') : '',
  ].filter(Boolean).join('\n');

  const page = await engine.putPage(slug, {
    title: result.question.slice(0, 200),
    type: 'synthesis',
    compiled_truth: body,
    frontmatter: {
      type: 'synthesis',
      question: result.question,
      model: result.modelUsed,
      date: today,
      pages_gathered: result.pagesGathered,
      takes_gathered: result.takesGathered,
    },
  });

  const persisted = await persistCitations(engine, page.id, result.citations);
  return { slug, evidenceInserted: persisted.inserted, warnings: persisted.warnings };
}
