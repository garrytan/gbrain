/**
 * `gbrain init --json`'s first-run decision bundle (agent contract v1 D2,
 * spec G5): ONE `kind: 'ask'` notice whose `decisions[]` carry what the human
 * output relays through `[AGENT]` lines, plus one `user_message`. Init stays
 * non-blocking (exit 0); the agent relays the message and applies the chosen
 * options' argv.
 *
 * Decisions: `search_mode` (the picker's recommendation and cost matrix),
 * `writeback` (in effect `off`, recommended `salient`, offered on a personal brain whose
 * operator has not answered) and the
 * optional `skills_scaffold` (recommended skills missing from the detected
 * agent workspace; default skip), then `upkeep` (GBRA-438: the free upkeep
 * line, a setting in effect whose default `on` needs no answer; it rides a
 * bundle that has another entry and never opens one alone) and
 * `conversation_archive` (GST-2768: on, or offered on a shared brain; rides the
 * same way). Human output renders the same bundle
 * (`[AGENT]` block without a terminal, `Note` lines on one); it replaces
 * init's separate writeback ask and skills pointer. Extend
 * `buildInitFirstRunNotices` rather than adding another settings notice; the
 * one separate notice is `harness_wiring`, an install step the agent does.
 */
import { cliRenderContext, renderNotice, shellQuote, type Decision, type Notice } from '../core/agent-output.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { resolveGbrainBin } from '../core/gbrain-bin.ts';
import { configReadiness, embeddingEnablement, harnessWiringEntry } from '../core/readiness.ts';
import type { SearchMode } from '../core/search/mode.ts';
import { costMatrixSentence, OPENAI_COST_MATRIX_MODELS } from '../core/search/mode-advice.ts';
import type { McpSurface } from '../mcp/surface.ts';
import { awaitingAnswer } from '../core/telemetry/client.ts';
import { telemetryEndpoint } from '../core/telemetry/endpoint.ts';

export interface InitFirstRunInputs {
  /** The search mode the install-time picker applied and why; absent when `--search-mode` recorded the operator's choice. */
  searchMode?: { mode: SearchMode; reason: string };
  /** The config init saved; harness wiring is read from its config-plane readiness. */
  config?: GBrainConfig | null;
  /** True when the ambient-writeback ask applies (`writebackAskApplies`). */
  writeback?: boolean;
  /** Recommended skills missing from the agent workspace (`initSkillsScaffold`). */
  skillsScaffold?: { missing: string[]; argv: string[] } | null;
  /** `gbrain init --surface`: the surface the harness registration pins (default the harness's registrationProfile). */
  surface?: McpSurface;
  /** GBRA-438: the upkeep line, relayed with the block as a setting in effect; `embedding` says the capped embedding step applies. */
  upkeep?: { embedding: boolean };
  /** GST-2768: the conversation archive line, a setting in effect: on (a personal brain) or offered (a shared one). */
  archive?: { state: 'on' | 'offered'; embedding: boolean };
  /** Opt-in usage telemetry has no answer yet (docs/guides/telemetry.md); only a person answers it. */
  telemetry?: boolean;
}

/** GBRA-438: what runs on its own, stated as a setting in effect (the plan's wording; the keyed form names the one capped paid step). */
export function upkeepLine(embedding: boolean): string {
  return "Upkeep: free upkeep runs on its own while your agent's gbrain session is open. "
    + (embedding
      ? 'Nothing is deleted without you, and the only paid step is embedding new text, capped at $1 a day (maintenance.embed_daily_usd). '
      : 'Nothing is deleted or paid for without you. ')
    + 'Turn off: gbrain config set maintenance.auto false. Optional schedule: gbrain maintain --schedule.';
}

/** GST-2768: the conversation archive as a setting in effect: what it keeps, where, what leaves the machine, how to change it. */
export function archiveLine(state: 'on' | 'offered', embedding: boolean): string {
  if (state === 'offered') {
    return 'Conversation archive: off on this shared brain. Turn it on with gbrain transcripts archive on: one redacted page per conversation per day from '
      + 'your agent sessions, kept to the owner member, in the conversations source.';
  }
  return 'Conversation archive: on. gbrain keeps one redacted page per conversation per day from your agent sessions (Claude Code, Codex, OpenClaw, Hermes, Grok) '
    + 'in the conversations source, written by the maintenance pass. '
    + (embedding
      ? 'New days are embedded like any new page (unattended upkeep caps that at maintenance.embed_daily_usd); older history is keyword-only until you approve its cost (gbrain embed --held --dry-run). '
      : 'Without an embedding key nothing leaves this machine. ')
    + 'Turn off: gbrain transcripts archive off.';
}

function archiveDecision(state: 'on' | 'offered', embedding: boolean): Decision {
  return {
    id: 'conversation_archive',
    question: archiveLine(state, embedding),
    options: [
      { id: 'on', label: state === 'on' ? 'Keep the conversation archive on (in effect now)' : 'Turn the conversation archive on', ...(state === 'on' ? {} : { argv: ['gbrain', 'transcripts', 'archive', 'on'] }) },
      { id: 'off', label: state === 'on' ? 'Turn the conversation archive off' : 'Keep it off (in effect now)', ...(state === 'on' ? { argv: ['gbrain', 'transcripts', 'archive', 'off'] } : {}) },
    ],
    default: state === 'on' ? 'on' : 'off',
    default_reason: state === 'on'
      ? 'In effect now: on by default on a personal brain; nothing needs an answer.'
      : 'A shared brain is only offered the archive; it stays off until the owner turns it on.',
  };
}

/** What the person is told about opt-in usage telemetry; the agent relays it and never answers for them. */
export const TELEMETRY_LINE = 'Usage data: gbrain sends nothing unless you say yes. If you want to help find broken setups and upgrades, say anonymous '
  + '(setup, upgrade and doctor results and daily command and error-code counts) or community (the same plus a random install id); '
  + 'it never sends your pages, queries, file paths or error messages, and gbrain telemetry show prints exactly what would be sent.';

function telemetryDecision(): Decision {
  const set = (tier: string) => ['gbrain', 'telemetry', tier];
  return {
    id: 'telemetry',
    question: `${TELEMETRY_LINE} Only the person answers this: ask them, run the command for the option they pick, and leave it unanswered when no person can answer. Never pick one yourself, and --yes or an unattended run never answers it.`,
    options: [
      { id: 'unanswered', label: 'Leave it unanswered (in effect now: nothing is sent)' },
      { id: 'anonymous', label: 'Anonymous: usage results and counts, no install id', argv: set('anonymous') },
      { id: 'community', label: 'Community: the same plus a random install id', argv: set('community') },
      { id: 'off', label: 'Off: send nothing and stop asking', argv: set('off') },
    ],
    default: 'unanswered',
    default_reason: 'In effect now: nothing is sent. No option is recommended, because only the person can agree to share usage data.',
  };
}

function upkeepDecision(embedding: boolean): Decision {
  return {
    id: 'upkeep',
    question: upkeepLine(embedding),
    options: [
      { id: 'on', label: 'Keep free upkeep on (in effect now)' },
      { id: 'off', label: 'Turn free upkeep off', argv: ['gbrain', 'config', 'set', 'maintenance.auto', 'false'] },
    ],
    default: 'on',
    default_reason: 'In effect now: the agent\'s gbrain serve runs the free upkeep tier while idle; nothing needs an answer.',
  };
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

/**
 * Connecting gbrain to the agent is an install step, never a setting waiting
 * for the user's OK (Garry's G, GST-2719): its own notice, so an agent that
 * relays the settings has already connected memory.
 */
function harnessWiringNotice(config: GBrainConfig, surface?: McpSurface): Notice | null {
  const entry = configReadiness(config, { transport: 'cli', ...(surface ? { surface } : {}) }).entries.find(e => e.capability === 'harness_wiring');
  if (!entry?.fix || entry.state === 'ok') return null;
  const fix = entry.fix;
  const registration = !!fix.argv && fix.actor === 'agent' && fix.consent.length === 1 && fix.consent[0] === 'persistent_install';
  if (!registration) {
    return {
      code: 'harness_wiring',
      kind: 'info',
      why: `gbrain is not connected to an agent here, and this step is not a command the agent runs by itself; say so in the reply that reports the install, without waiting on it. ${fix.user_message ?? ''} ${fix.why ?? ''}`.trim(),
      fix,
    };
  }
  return {
    code: 'harness_wiring',
    kind: 'info',
    why: 'Connect gbrain to the agent now, as part of this install: it is an install step, not a setting, so do it before reporting the install. The fix names the command for this host.',
    fix: { ...fix, actor: 'agent', consent: [], user_message: undefined },
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
    default: 'off',
    default_reason: 'In effect now: agents save only what the user asks them to remember. salient is recommended for a personal brain; it is opt-in, so it turns on only when the user picks it.',
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
  if (inputs.skillsScaffold?.missing.length) decisions.push(skillsScaffoldDecision(inputs.skillsScaffold));
  if (inputs.telemetry) decisions.push(telemetryDecision());
  const wiring = inputs.config ? harnessWiringNotice(inputs.config, inputs.surface) : null;
  if (decisions.length === 0 && !(wiring && inputs.upkeep)) return wiring ? [wiring] : [];
  if (inputs.upkeep) decisions.push(upkeepDecision(inputs.upkeep.embedding));
  if (inputs.archive) decisions.push(archiveDecision(inputs.archive.state, inputs.archive.embedding));
  const searchMode = decisions.find(d => d.id === 'search_mode');
  const upkeep = decisions.find(d => d.id === 'upkeep');
  const archive = decisions.find(d => d.id === 'conversation_archive');
  const telemetry = decisions.some(d => d.id === 'telemetry');
  const inEffect = [
    ...(searchMode ? [`search mode ${searchMode.default}`] : []),
    ...(decisions.some(d => d.id === 'writeback') ? [WRITEBACK_IN_EFFECT] : []),
  ];
  return [...(wiring ? [wiring] : []), {
    code: 'first_run_decisions',
    kind: 'ask',
    why: 'The brain is ready and these first-run settings are in effect as listed; none blocks memory. '
      + 'Relay them once, in the reply that reports the install, as the current settings and how to change them; do not hold the install open or end it waiting on an answer. '
      + 'When the user picks an option, run its command. Nothing paid turns on from these settings without a key the user supplied.',
    user_message: `gbrain is installed.${inEffect.length ? ` In effect: ${inEffect.join('; ')}.` : ''}${upkeep ? ` ${upkeep.question}` : ''}${archive ? ` ${archive.question}` : ''}${searchMode ? ` ${costMatrixSentence()}` : ''}${telemetry ? ` ${TELEMETRY_LINE}` : ''} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
    decisions,
  }];
}

const WRITEBACK_IN_EFFECT = 'agents save only what you ask them to remember, until you turn on automatic saving (salient is recommended: durable facts you state, saved with provenance)';

/**
 * `gbrain setup <harness>`'s form of init's bundle (read from `init --json`).
 * Setup has already wired the harness, so `harness_wiring` is dropped, and
 * the rest is framed as settings in effect that the user can change at any
 * time: the agent relays them in the reply that reports the install instead
 * of ending it on a question whose answer needs another turn (Cat 41 wave 2).
 * Open decisions keep returning in later sessions until answered or muted.
 * The Report back (Wakeshift) row states whether gbrain wakes the agent's
 * conversation when a job finishes (`opts.reportBack`: published) and the
 * one command that flips it.
 */
export function setupFirstRunNotices(initNotices: readonly unknown[], harness: string, opts: { reportBack?: boolean } = {}): Notice[] {
  const bundle = initNotices.find((n): n is Notice => (n as Notice | null)?.code === 'first_run_decisions');
  const matrix = costMatrixSentence(harness === 'Codex' ? OPENAI_COST_MATRIX_MODELS : undefined);
  const decisions = (bundle?.decisions ?? []).filter(d => d.id !== 'harness_wiring')
    .map(d => (d.id === 'search_mode' ? { ...d, question: `Which search mode should this brain use? ${matrix}` } : d));
  if (decisions.length === 0) return [];
  const searchMode = decisions.find(d => d.id === 'search_mode');
  const upkeep = decisions.find(d => d.id === 'upkeep');
  const archive = decisions.find(d => d.id === 'conversation_archive');
  const inEffect = [
    ...(searchMode ? [`search mode ${searchMode.default}`] : []),
    ...(decisions.some(d => d.id === 'writeback') ? [WRITEBACK_IN_EFFECT] : []),
  ];
  const telemetry = decisions.some(d => d.id === 'telemetry');
  if (inEffect.length === 0 && !upkeep && !archive && !telemetry) return [];
  const reportBack = opts.reportBack
    ? 'Report back (Wakeshift): on. gbrain wakeshift disable turns it off.'
    : 'Report back (Wakeshift): off. gbrain wakeshift enable turns it on.';
  return [{
    code: 'first_run_decisions',
    kind: 'ask',
    why: `Setup is complete: the brain is ready and ${harness} is wired, so memory works now. These first-run settings are in effect as listed; none blocks memory or needs a new session to answer. `
      + 'Relay them once, in the reply that reports this install, as the current settings and how to change them; do not hold the install open or end it waiting on an answer. '
      + 'When the user picks an option, run its command. Automatic saving (`writeback`) is separate from setup\'s capture decision (Stop/SessionEnd hooks); while unanswered it comes back in a later session until the user answers or mutes it.',
    user_message: `gbrain is set up and ${harness} is wired, so memory works now.${inEffect.length ? ` In effect: ${inEffect.join('; ')}.` : ''} ${reportBack}${upkeep ? ` ${upkeep.question}` : ''}${archive ? ` ${archive.question}` : ''}${searchMode ? ` ${matrix}` : ''}${telemetry ? ` ${TELEMETRY_LINE}` : ''} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
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
  const { isAvailable } = await import('../core/ai/gateway.ts');
  let embedding = false;
  try { embedding = isAvailable('embedding'); } catch { /* gateway not configured: keyless */ }
  const { resolveArchiveEnabled } = await import('../core/transcripts/archive-default.ts');
  const archive = await resolveArchiveEnabled(engine, { config: loadConfig() }).catch(() => null);
  const archiveState = archive?.enabled ? 'on' as const : archive?.offered ? 'offered' as const : null;
  return buildInitFirstRunNotices({
    searchMode, config: loadConfig(), writeback: await writebackAskApplies(engine), skillsScaffold: initSkillsScaffold(), surface, upkeep: { embedding },
    ...(archiveState ? { archive: { state: archiveState, embedding } } : {}),
    telemetry: awaitingAnswer() && telemetryEndpoint() !== null,
  });
}

/** D2/G5: the bundle rendered into init's --json document (`notices`, empty → omitted). */
export function firstRunJson(bundle: Notice[]): { notices?: unknown[]; contract_version: 1 } {
  const notices = bundle.map(n => renderNotice(n, cliRenderContext()));
  return { ...(notices.length ? { notices } : {}), contract_version: 1 };
}

/**
 * The harness registration line for init's quickstart: the readiness
 * `harness_wiring` fix (absolute binary, the harness's registrationProfile, e.g.
 * Codex `--surface full`, unless `gbrain init --surface` names another) for the detected harness, else the
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
