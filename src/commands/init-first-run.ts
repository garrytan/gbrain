/**
 * `gbrain init --json`'s first-run decision bundle (agent contract v1 D2,
 * spec G5): ONE `kind: 'ask'` notice whose `decisions[]` carry what the human
 * output relays through `[AGENT]` lines, plus one `user_message`. Init stays
 * non-blocking (exit 0); the agent relays the message and applies the chosen
 * options' argv.
 *
 * Decisions: `search_mode` (the picker's recommendation and cost matrix),
 * `writeback` (recommended `salient`, offered on a personal brain whose
 * operator has not answered), `harness_wiring` (the A7 readiness fix) and the
 * optional `skills_scaffold` (recommended skills missing from the detected
 * agent workspace; default skip). Human output renders the same bundle
 * (`[AGENT]` block without a terminal, `Note` lines on one); it replaces
 * init's separate writeback ask and skills pointer. Extend
 * `buildInitFirstRunNotices` rather than adding a second notice.
 */
import { cliRenderContext, renderNotice, shellQuote, type Decision, type Notice } from '../core/agent-output.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { resolveGbrainBin } from '../core/gbrain-bin.ts';
import { configReadiness, embeddingEnablement, harnessWiringEntry } from '../core/readiness.ts';
import type { SearchMode } from '../core/search/mode.ts';
import { costMatrixSentence } from '../core/search/mode-advice.ts';
import type { McpSurface } from '../mcp/surface.ts';

export interface InitFirstRunInputs {
  /** The search mode the install-time picker applied and why; absent when `--search-mode` recorded the operator's choice. */
  searchMode?: { mode: SearchMode; reason: string };
  /** The config init saved; harness wiring is read from its config-plane readiness. */
  config?: GBrainConfig | null;
  /** True when the ambient-writeback ask applies (`writebackAskApplies`). */
  writeback?: boolean;
  /** Recommended skills missing from the agent workspace (`initSkillsScaffold`). */
  skillsScaffold?: { missing: string[]; argv: string[] } | null;
  /** `gbrain init --surface`: the surface the harness registration pins (default REGISTRATION_SURFACE). */
  surface?: McpSurface;
}

function searchModeDecision(applied: { mode: SearchMode; reason: string }): Decision {
  const modes: SearchMode[] = ['conservative', 'balanced', 'tokenmax'];
  return {
    id: 'search_mode',
    question: `Which search mode should this brain use? ${costMatrixSentence()}`,
    options: modes.map(m => ({ id: m, label: m === applied.mode ? `${m} (applied)` : m, argv: ['gbrain', 'config', 'set', 'search.mode', m] })),
    default: applied.mode,
    default_reason: applied.reason,
  };
}

function harnessWiringDecision(config: GBrainConfig, surface?: McpSurface): Decision | null {
  const entry = configReadiness(config, { transport: 'cli', ...(surface ? { surface } : {}) }).entries.find(e => e.capability === 'harness_wiring');
  if (!entry?.fix || entry.state === 'ok') return null;
  return {
    id: 'harness_wiring',
    question: entry.fix.user_message ?? entry.why,
    options: [
      { id: 'wire', label: entry.fix.why, ...(entry.fix.argv ? { argv: entry.fix.argv } : {}) },
      { id: 'skip', label: 'Do not register gbrain with an agent harness now.' },
    ],
    default: entry.fix.argv ? 'wire' : 'skip',
    default_reason: entry.why,
  };
}

function writebackDecision(): Decision {
  const set = (mode: string) => ['gbrain', 'config', 'set', 'memory.auto_writeback', mode];
  return {
    id: 'writeback',
    question: 'Should agents save important facts the user states (preferences, decisions, commitments) automatically, with provenance? '
      + 'Saved facts are readable by agents connected to this brain; transient facts expire. Off any time with `gbrain config set memory.auto_writeback off`.',
    options: [
      { id: 'salient', label: 'Save durable facts the user states directly (recommended)', argv: set('salient') },
      { id: 'all', label: 'Every direct factual statement (more low-value facts, more extraction spend)', argv: set('all') },
      { id: 'off', label: 'Save only what the user explicitly asks to remember (records the answer)', argv: set('off') },
    ],
    default: 'salient',
    default_reason: 'Recommended for a personal brain: the brain learns what the user tells their agents. It is opt-in, so it applies only when the user accepts the defaults or picks it.',
  };
}

function skillsScaffoldDecision(scaffold: { missing: string[]; argv: string[] }): Decision {
  const preview = scaffold.missing.slice(0, 4).join(', ') + (scaffold.missing.length > 4 ? ', …' : '');
  return {
    id: 'skills_scaffold',
    question: `Install ${scaffold.missing.length} recommended gbrain skill(s) into the agent workspace (${preview})? Optional; \`gbrain advisor\` lists what each does.`,
    options: [
      { id: 'skip', label: 'Skip for now.' },
      { id: 'scaffold', label: 'Scaffold the recommended skills into the workspace.', argv: scaffold.argv },
    ],
    default: 'skip',
    default_reason: 'Optional: the brain works without them; scaffolding writes files into the user\'s workspace.',
  };
}

/** The bundle: empty when there is nothing to decide. */
export function buildInitFirstRunNotices(inputs: InitFirstRunInputs): Notice[] {
  const decisions: Decision[] = [];
  if (inputs.searchMode) decisions.push(searchModeDecision(inputs.searchMode));
  if (inputs.writeback) decisions.push(writebackDecision());
  if (inputs.config) {
    const wiring = harnessWiringDecision(inputs.config, inputs.surface);
    if (wiring) decisions.push(wiring);
  }
  if (inputs.skillsScaffold?.missing.length) decisions.push(skillsScaffoldDecision(inputs.skillsScaffold));
  if (decisions.length === 0) return [];
  const defaults = decisions.map(d => `${d.id}: ${d.default}`).join('; ');
  return [{
    code: 'first_run_decisions',
    kind: 'ask',
    why: 'The brain is ready. These settings were applied with defaults or need the user\'s choice; none blocks using the brain.',
    user_message: `gbrain is installed. Reply 'defaults' to keep the recommended settings (${defaults}), or tell me what to change.`,
    decisions,
  }];
}

/**
 * `gbrain setup <harness>`'s form of init's bundle (read from `init --json`).
 * Setup has already wired the harness, so `harness_wiring` is dropped, and
 * the rest is framed as settings in effect that the user can change at any
 * time: the agent relays them in the reply that reports the install instead
 * of ending it on a question whose answer needs another turn (Cat 41 wave 2).
 * Open decisions keep returning in later sessions until answered or muted.
 */
export function setupFirstRunNotices(initNotices: readonly unknown[], harness: string): Notice[] {
  const bundle = initNotices.find((n): n is Notice => (n as Notice | null)?.code === 'first_run_decisions');
  const decisions = (bundle?.decisions ?? []).filter(d => d.id !== 'harness_wiring');
  if (decisions.length === 0) return [];
  const searchMode = decisions.find(d => d.id === 'search_mode');
  const inEffect = [
    ...(searchMode ? [`search mode ${searchMode.default}`] : []),
    ...(decisions.some(d => d.id === 'writeback') ? ['agents save only what you ask them to remember, until you turn on automatic saving (gbrain recommends salient: durable facts you state, saved with provenance)'] : []),
  ];
  if (inEffect.length === 0) return [];
  return [{
    code: 'first_run_decisions',
    kind: 'ask',
    why: `Setup is complete: the brain is ready and ${harness} is wired, so memory works now. These first-run settings are in effect as listed; none blocks memory or needs a new session to answer. `
      + 'Relay them once, in the reply that reports this install, as the current settings and how to change them; do not hold the install open or end it waiting on an answer. '
      + 'When the user picks an option, run its command. Automatic saving (`writeback`) is separate from setup\'s capture decision (Stop/SessionEnd hooks); while unanswered it comes back in a later session until the user answers or mutes it.',
    user_message: `gbrain is set up and ${harness} is wired, so memory works now. In effect: ${inEffect.join('; ')}.${searchMode ? ` ${costMatrixSentence()}` : ''} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
    decisions,
  }];
}

/**
 * The deferred-setup line init prints for `--no-embedding`: the same enable
 * command readiness gives doctor, embed and MCP (A7 `embeddingEnablement`:
 * resolved datastore, a provider that fits, pages and facts kept).
 */
export function deferredEmbeddingHint(cfg: GBrainConfig): string {
  const enable = embeddingEnablement(cfg);
  const step = enable.argv ? shellQuote(enable.argv) : 'gbrain doctor --only embeddings --json';
  return `  --no-embedding: deferred setup — enable later with \`${step}\` (setting embedding_model through \`gbrain config set\` is refused by design)`;
}

/** init's bundle for this brain: reads the writeback gate and the agent workspace's missing skills. */
export async function firstRunBundle(engine: BrainEngine, searchMode: { mode: SearchMode; reason: string } | undefined, surface?: McpSurface): Promise<Notice[]> {
  const { writebackAskApplies } = await import('../core/onboard/writeback-nudge.ts');
  const { initSkillsScaffold } = await import('../core/skillpack/post-install-advisory.ts');
  return buildInitFirstRunNotices({ searchMode, config: loadConfig(), writeback: await writebackAskApplies(engine), skillsScaffold: initSkillsScaffold(), surface });
}

/** D2/G5: the bundle rendered into init's --json document (`notices`, empty → omitted). */
export function firstRunJson(bundle: Notice[]): { notices?: unknown[]; contract_version: 1 } {
  const notices = bundle.map(n => renderNotice(n, cliRenderContext()));
  return { ...(notices.length ? { notices } : {}), contract_version: 1 };
}

/**
 * The harness registration line for init's quickstart: the readiness
 * `harness_wiring` fix (absolute binary, `--surface full` unless
 * `gbrain init --surface` names another) for the detected harness, else the
 * Claude Code registration built the same way. Null when the gbrain binary
 * has no absolute path (never registered bare).
 */
export function harnessRegistrationCommand(surface?: McpSurface): string | null {
  const cfg = loadConfig();
  const detected = cfg ? configReadiness(cfg, { transport: 'cli', ...(surface ? { surface } : {}) }).entries.find(e => e.capability === 'harness_wiring')?.fix : undefined;
  if (detected?.argv) return shellQuote(detected.argv);
  const claude = harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code'], lockOwner: null, gbrainBin: resolveGbrainBin(), ...(surface ? { surface } : {}) }).fix;
  return claude?.argv ? shellQuote(claude.argv) : null;
}
