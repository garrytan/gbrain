/**
 * Prompt registry — the catalog behind the admin Prompts page.
 *
 * Every LLM prompt the service sends is declared here with metadata:
 * where it lives, what feature uses it, whether an operator can override
 * its text, and which `{PLACEHOLDER}` tokens the call site substitutes at
 * runtime (an override that drops a required placeholder is rejected by
 * the admin PUT route).
 *
 * Two tiers:
 *   - `editable: true` — the call site resolves through
 *     `resolvePromptText(engine, id, DEFAULT)` (src/core/prompts/resolve.ts),
 *     so a config row `prompts.<id>` set from the admin UI takes effect on
 *     the next run. No restart needed.
 *   - `editable: false` — the prompt is a template FUNCTION interpolating
 *     runtime values (or runs on a path with no engine handle). Listed for
 *     visibility/traceability; overriding requires a code change. Converting
 *     one to editable = extract the skeleton to `{PLACEHOLDER}` form and
 *     thread `resolvePromptText` at its call site, then flip this flag.
 *
 * IMPORTANT: this module imports prompt constants from feature modules.
 * Feature modules must NEVER import from this file (they import
 * `./resolve.ts` only) — that keeps the dependency graph acyclic. The only
 * consumers of the registry are the admin routes in serve-http.ts and tests.
 */

import { EXTRACTOR_SYSTEM } from '../facts/extract.ts';
import { CLASSIFIER_SYSTEM as FACTS_CLASSIFIER_SYSTEM } from '../facts/classify.ts';
import { EXTRACT_TAKES_PROMPT, PROPOSE_TAKES_PROMPT_VERSION } from '../cycle/propose-takes.ts';
import { GRADE_TAKE_PROMPT, GRADE_TAKES_PROMPT_VERSION } from '../cycle/grade-takes.ts';
import { PATTERN_STATEMENTS_PROMPT, BIAS_TAGS_PROMPT, CALIBRATION_PROFILE_PROMPT_VERSION } from '../cycle/calibration-profile.ts';
import { DRIFT_JUDGE_PROMPT } from '../cycle/drift.ts';
import { SYNTH_PROMPT } from '../cycle/synthesize-concepts.ts';
import { EXTRACT_PROMPT as EXTRACT_ATOMS_PROMPT } from '../cycle/extract-atoms.ts';
import { TAKES_CLASSIFIER_SYSTEM } from '../extract-takes-from-pages.ts';
import { CHRONICLE_JUDGE_SYSTEM } from '../chronicle/extract-events.ts';
import { POLISH_SYSTEM_PROMPT } from '../conversation-parser/llm-polish.ts';
import { FALLBACK_SYSTEM_PROMPT } from '../conversation-parser/llm-fallback.ts';
import { ENRICH_SYSTEM_PROMPT } from '../enrich/thin.ts';
import { THINK_SYSTEM_PROMPT_BASE } from '../think/prompt.ts';
import { SYNOPSIS_SYSTEM_PROMPT } from '../page-summary.ts';
import { INTENT_SYSTEM_PROMPT } from '../search/llm-intent.ts';
import { LLM_JUDGE_SYSTEM } from '../skillopt/score.ts';
import { HAIKU_GATE_PROMPT } from '../calibration/voice-gate.ts';
import { DEFAULT_SUBAGENT_SYSTEM } from '../minions/system-prompt.ts';

export interface PromptDef {
  /** Stable id; the config override key is `prompts.<id>`. */
  id: string;
  /** UI group (sidebar section on the Prompts page). */
  group: 'facts' | 'dream-cycle' | 'takes' | 'retrieval' | 'ingest' | 'other';
  /** Short human label. */
  label: string;
  /** What the prompt does + when it runs. */
  description: string;
  /** Source location for traceability, `path:constName`. */
  definedAt: string;
  /** Default prompt text (the hardcoded constant). */
  defaultText: string;
  /** `{TOKEN}` placeholders the call site substitutes; overrides must keep them. */
  requiredPlaceholders: string[];
  /** False = template-function prompt, listed read-only for visibility. */
  editable: boolean;
  /** Base version constant for version-cached phases, when one exists. */
  baseVersion?: string;
}

export const PROMPT_REGISTRY: PromptDef[] = [
  // ── Facts pipeline ────────────────────────────────────────────────
  {
    id: 'facts.extractor',
    group: 'facts',
    label: 'Fact extractor',
    description:
      'Extracts structured facts (event/preference/commitment/belief/fact + notability + metrics) from a conversation turn or page body. Used by inline extraction on put_page and by the conversation_facts_backfill dream phase.',
    definedAt: 'src/core/facts/extract.ts:EXTRACTOR_SYSTEM',
    defaultText: EXTRACTOR_SYSTEM,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'facts.classifier',
    group: 'facts',
    label: 'Fact dedupe/supersede classifier',
    description:
      'Judges whether a newly extracted fact duplicates, supersedes, or coexists with existing facts. Pure function without an engine handle — read-only until the classify path threads one.',
    definedAt: 'src/core/facts/classify.ts:CLASSIFIER_SYSTEM',
    defaultText: FACTS_CLASSIFIER_SYSTEM,
    requiredPlaceholders: [],
    editable: false,
  },

  // ── Dream cycle phases ────────────────────────────────────────────
  {
    id: 'cycle.extract_atoms',
    group: 'dream-cycle',
    label: 'Extract atoms',
    description:
      'Extracts atomic content nuggets (tweetable insights) from transcripts/articles into atom pages (extract_atoms phase; pack-gated).',
    definedAt: 'src/core/cycle/extract-atoms.ts:EXTRACT_PROMPT',
    defaultText: EXTRACT_ATOMS_PROMPT,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'cycle.synthesize_concepts',
    group: 'dream-cycle',
    label: 'Synthesize concepts',
    description:
      'Writes the 1-paragraph executive summary for a concept page from its referencing atoms (synthesize_concepts phase; pack-gated).',
    definedAt: 'src/core/cycle/synthesize-concepts.ts:SYNTH_PROMPT',
    defaultText: SYNTH_PROMPT,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'cycle.propose_takes',
    group: 'dream-cycle',
    label: 'Propose takes',
    description:
      'Extracts gradeable claims (predictions/judgments/bets) from page prose into the take_proposals review queue (propose_takes phase). Overriding re-runs extraction on every page: the effective prompt version gains a content digest, which invalidates the per-page skip-seen cache.',
    definedAt: 'src/core/cycle/propose-takes.ts:EXTRACT_TAKES_PROMPT',
    defaultText: EXTRACT_TAKES_PROMPT,
    requiredPlaceholders: ['EXISTING_TAKES_JSON', 'PAGE_BODY'],
    editable: true,
    baseVersion: PROPOSE_TAKES_PROMPT_VERSION,
  },
  {
    id: 'cycle.grade_takes',
    group: 'dream-cycle',
    label: 'Grade takes (judge)',
    description:
      'Judges unresolved takes against retrieved evidence and emits a verdict (grade_takes phase). Overriding invalidates the take_grade_cache via a digest-suffixed prompt version.',
    definedAt: 'src/core/cycle/grade-takes.ts:GRADE_TAKE_PROMPT',
    defaultText: GRADE_TAKE_PROMPT,
    requiredPlaceholders: ['CLAIM', 'KIND', 'HOLDER', 'SINCE_DATE', 'WEIGHT', 'EVIDENCE_BLOCK'],
    editable: true,
    baseVersion: GRADE_TAKES_PROMPT_VERSION,
  },
  {
    id: 'cycle.calibration_pattern_statements',
    group: 'dream-cycle',
    label: 'Calibration: pattern statements',
    description:
      'Summarizes a holder\'s forecasting track record into 2-4 narrative pattern statements (calibration_profile phase; voice-gated).',
    definedAt: 'src/core/cycle/calibration-profile.ts:PATTERN_STATEMENTS_PROMPT',
    defaultText: PATTERN_STATEMENTS_PROMPT,
    requiredPlaceholders: ['SCORECARD_JSON'],
    editable: true,
    baseVersion: CALIBRATION_PROFILE_PROMPT_VERSION,
  },
  {
    id: 'cycle.calibration_bias_tags',
    group: 'dream-cycle',
    label: 'Calibration: bias tags',
    description: 'Derives 1-4 active bias tags from the pattern statements (calibration_profile phase).',
    definedAt: 'src/core/cycle/calibration-profile.ts:BIAS_TAGS_PROMPT',
    defaultText: BIAS_TAGS_PROMPT,
    requiredPlaceholders: ['PATTERNS_BULLETS'],
    editable: true,
  },
  {
    id: 'cycle.drift_judge',
    group: 'dream-cycle',
    label: 'Drift judge',
    description:
      'Audits soft-band takes for drift against recent timeline evidence (drift phase; report-only, default OFF via dream.drift.enabled).',
    definedAt: 'src/core/cycle/drift.ts:DRIFT_JUDGE_PROMPT',
    defaultText: DRIFT_JUDGE_PROMPT,
    requiredPlaceholders: ['CLAIM', 'WEIGHT', 'PAGE', 'EVIDENCE_BLOCK'],
    editable: true,
  },
  {
    id: 'cycle.patterns',
    group: 'dream-cycle',
    label: 'Patterns (subagent)',
    description:
      'Cross-session theme roll-up subagent prompt (patterns phase). Template function interpolating the reflection corpus + configured slug prefixes — read-only until extracted to placeholder form.',
    definedAt: 'src/core/cycle/patterns.ts:buildPatternsPrompt()',
    defaultText: '',
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'cycle.synthesize_subagent',
    group: 'dream-cycle',
    label: 'Synthesize (subagent)',
    description:
      'Transcript-to-pages synthesis subagent prompt (synthesize phase). Template function interpolating transcript chunks + output namespace — read-only until extracted to placeholder form.',
    definedAt: 'src/core/cycle/synthesize.ts:buildSynthesisPrompt()',
    defaultText: '',
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'enrich.thin',
    group: 'dream-cycle',
    label: 'Enrich thin pages',
    description:
      'Grounded-dossier system prompt for developing thin stub pages from brain-internal evidence (enrich_thin phase + gbrain enrich). {SKIP_SENTINEL} is substituted at build time.',
    definedAt: 'src/core/enrich/thin.ts:ENRICH_SYSTEM_PROMPT',
    defaultText: ENRICH_SYSTEM_PROMPT,
    requiredPlaceholders: ['SKIP_SENTINEL'],
    editable: true,
  },

  // ── Takes ─────────────────────────────────────────────────────────
  {
    id: 'takes.bootstrap_classifier',
    group: 'takes',
    label: 'Takes bootstrap classifier',
    description:
      'Extracts gradeable claims from longform pages during takes bootstrap (gbrain takes bootstrap / extract-takes-from-pages).',
    definedAt: 'src/core/extract-takes-from-pages.ts:TAKES_CLASSIFIER_SYSTEM',
    defaultText: TAKES_CLASSIFIER_SYSTEM,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'takes.voice_gate',
    group: 'takes',
    label: 'Voice gate (Haiku)',
    description:
      'Judges whether generated calibration surfaces read naturally per rubric. Rubric + candidate are interpolated by the voice-gate module — read-only.',
    definedAt: 'src/core/calibration/voice-gate.ts:HAIKU_GATE_PROMPT',
    defaultText: HAIKU_GATE_PROMPT,
    requiredPlaceholders: ['RUBRIC', 'CANDIDATE'],
    editable: false,
  },

  // ── Retrieval / synthesis ─────────────────────────────────────────
  {
    id: 'think.system',
    group: 'retrieval',
    label: 'Think (synthesis engine)',
    description:
      'Base system prompt for gbrain think — answers questions across the brain with citations, conflicts, and gaps. Conditional blocks (anchor, time window, calibration) are appended after this base.',
    definedAt: 'src/core/think/prompt.ts:THINK_SYSTEM_PROMPT_BASE',
    defaultText: THINK_SYSTEM_PROMPT_BASE,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'search.llm_intent',
    group: 'retrieval',
    label: 'Search intent classifier',
    description:
      'Classifies query intent for cross-modal tie-breaks (gated by search.cross_modal.llm_intent). Runs on a hot path without an engine handle — read-only.',
    definedAt: 'src/core/search/llm-intent.ts:INTENT_SYSTEM_PROMPT',
    defaultText: INTENT_SYSTEM_PROMPT,
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'pages.synopsis',
    group: 'retrieval',
    label: 'Chunk synopsis',
    description:
      'Generates one-sentence chunk synopses for contextual embeddings. Cached by SYNOPSIS_PROMPT_VERSION on a high-volume path — read-only until version plumbing supports overrides.',
    definedAt: 'src/core/page-summary.ts:SYNOPSIS_SYSTEM_PROMPT',
    defaultText: SYNOPSIS_SYSTEM_PROMPT,
    requiredPlaceholders: [],
    editable: false,
  },

  // ── Ingest / parsing ──────────────────────────────────────────────
  {
    id: 'chronicle.judge',
    group: 'ingest',
    label: 'Chronicle event segmenter',
    description: 'Segments meeting/transcript pages into discrete timeline events (chronicle extraction).',
    definedAt: 'src/core/chronicle/extract-events.ts:CHRONICLE_JUDGE_SYSTEM',
    defaultText: CHRONICLE_JUDGE_SYSTEM,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'conversation_parser.polish',
    group: 'ingest',
    label: 'Conversation parser: polish',
    description:
      'Polishes regex-parsed chat messages (merge continuations, drop noise). Gated by conversation_parser.llm_polish_enabled.',
    definedAt: 'src/core/conversation-parser/llm-polish.ts:POLISH_SYSTEM_PROMPT',
    defaultText: POLISH_SYSTEM_PROMPT,
    requiredPlaceholders: [],
    editable: true,
  },
  {
    id: 'conversation_parser.fallback',
    group: 'ingest',
    label: 'Conversation parser: LLM fallback',
    description:
      'Full LLM parse of chat-log bodies no regex pattern matched. Gated by conversation_parser.llm_fallback_enabled.',
    definedAt: 'src/core/conversation-parser/llm-fallback.ts:FALLBACK_SYSTEM_PROMPT',
    defaultText: FALLBACK_SYSTEM_PROMPT,
    requiredPlaceholders: [],
    editable: true,
  },

  // ── Other ─────────────────────────────────────────────────────────
  {
    id: 'skillopt.llm_judge',
    group: 'other',
    label: 'SkillOpt: LLM judge',
    description: 'Scores agent output against a rubric during skill optimization (skillopt phase, default OFF). Read-only.',
    definedAt: 'src/core/skillopt/score.ts:LLM_JUDGE_SYSTEM',
    defaultText: LLM_JUDGE_SYSTEM,
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'minions.subagent_default',
    group: 'other',
    label: 'Minion subagent default system',
    description:
      'Default system prompt for subagent minion jobs. Per-job data.system already overrides it — read-only here.',
    definedAt: 'src/core/minions/system-prompt.ts:DEFAULT_SUBAGENT_SYSTEM',
    defaultText: DEFAULT_SUBAGENT_SYSTEM,
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'brainstorm.cross',
    group: 'other',
    label: 'Brainstorm: idea generation',
    description:
      'Close×far bisociation idea generator. Voice/constraint come from the brainstorm profile row (DB); the skeleton is a template function — read-only.',
    definedAt: 'src/core/brainstorm/orchestrator.ts:buildCrossPrompt()',
    defaultText: '',
    requiredPlaceholders: [],
    editable: false,
  },
  {
    id: 'brainstorm.judge',
    group: 'other',
    label: 'Brainstorm: judge panel',
    description:
      'Five-axis idea scoring judge. Axis weights + extra instructions are configurable via JudgeConfig; the skeleton is a template function — read-only.',
    definedAt: 'src/core/brainstorm/judges.ts:buildJudgePrompt()',
    defaultText: '',
    requiredPlaceholders: [],
    editable: false,
  },
];

/** Lookup by id; undefined when the id is not in the registry. */
export function getPromptDef(id: string): PromptDef | undefined {
  return PROMPT_REGISTRY.find((p) => p.id === id);
}
