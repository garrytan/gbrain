/**
 * `chat_fallback_chain` doctor check: which chain `chat()` walks, the config
 * plane it comes from (env `GBRAIN_CHAT_FALLBACK_CHAIN` > config.json > DB),
 * every shadowed value, the providers that receive traffic, and whether it
 * also falls back on refusals (`chat_fallback_on_refusal`).
 *
 * An active, healthy chain is an informational `ok` whose optional `fix` is
 * the per-plane removal guidance (`ask_user` or `tell_user_to_run`, never
 * `run`). A malformed entry or plane value, a provider with no credential
 * present, or an unpriced model under a user-set cost cap is a `warn` with a
 * cause-specific fix. Presence checks only: no network, subprocess or
 * inference call (src/core/ai/chat-fallback-planes.ts).
 *
 * The remote report (`run_doctor`) says only that a chain is configured and
 * how many problems it has; entries and providers stay on the brain host.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Action } from '../../../core/agent-output.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../../../core/config.ts';
import { mergedProviderEnv } from '../../../core/ai/provider-env.ts';
import { loadPricingOverrides } from '../../../core/budget/budget-tracker.ts';
import { noPricingFix, noPricingGuidance } from '../../../core/budget/no-pricing.ts';
import {
  USER_CHAT_CAP_KEYS,
  diagnoseChatFallbackEntry,
  readChatFallbackPlanes,
  type ChatFallbackPlane,
  type ChatFallbackPlanes,
  type EntryDiagnosis,
  CHAT_FALLBACK_PLANE_LABEL as PLANE_LABEL,
  chatFallbackRemovalFix,
} from '../../../core/ai/chat-fallback-planes.ts';
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'chat_fallback_chain';
const DOCS = 'docs/guides/chat-fallback.md';

export { chatFallbackRemovalFix };

function credentialFix(d: EntryDiagnosis, plane: ChatFallbackPlane, filePath: string): Action {
  return {
    consent: ['credentials'], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME), docs: DOCS,
    why: `${d.detail} The chain would hand ${d.entry} a request it cannot authenticate. Provide the credential, or remove the entry (${PLANE_LABEL[plane]}).`,
    user_message: d.provider === 'claude-cli'
      ? `The fallback model ${d.entry} runs through the claude CLI, which is not installed here. Install and log in to Claude Code, or set GBRAIN_CLAUDE_CLI_BIN, or remove that entry.`
      : `The fallback model ${d.entry} needs ${d.credential}. Set it where gbrain runs, or remove that entry from ${plane === 'file' ? filePath : PLANE_LABEL[plane]}.`,
  };
}

async function userCapKeys(engine: BrainEngine | null, cfg: GBrainConfig | null): Promise<string[]> {
  const found: string[] = [];
  for (const key of USER_CHAT_CAP_KEYS) {
    const leaf = key.startsWith('cycle.') ? key.slice('cycle.'.length) : null;
    if (leaf && cfg?.cycle?.[leaf] !== undefined) { found.push(key); continue; }
    if (!engine) continue;
    try { if (await engine.getConfig(key)) found.push(key); } catch { /* unreadable: not a cap */ }
  }
  return found;
}

function chainSummary(planes: ChatFallbackPlanes, diags: EntryDiagnosis[]): Record<string, unknown> {
  return {
    plane: planes.effective?.plane ?? null,
    chain: planes.effective?.chain ?? [],
    providers: [...new Set(diags.map(d => d.provider).filter((p): p is string => !!p))],
    shadowed: planes.shadowed,
    malformed: planes.malformed,
    on_refusal: planes.onRefusal,
    entries: diags,
  };
}

export async function checkChatFallbackChain(engine: BrainEngine | null, opts: { remote?: boolean } = {}): Promise<Check> {
  try {
    const planes = await readChatFallbackPlanes(engine);
    if (!planes.effective && planes.malformed.length === 0) {
      return { name: 'chat_fallback_chain', status: 'ok', message: 'No chat_fallback_chain is set: every chat call uses only its own model.' };
    }
    let cfg: GBrainConfig | null = null;
    try { cfg = loadConfig(); } catch { cfg = null; }
    if (engine && cfg) { try { cfg = await loadConfigWithEngine(engine, cfg) ?? cfg; } catch { /* file/env only */ } }
    const env = mergedProviderEnv(cfg, process.env);
    const pricingOverrides = engine ? await loadPricingOverrides(engine) : undefined;
    const caps = await userCapKeys(engine, cfg);
    const diags = (planes.effective?.chain ?? []).map(entry => diagnoseChatFallbackEntry(entry, { env, pricingOverrides, userCapKeys: caps }));
    const problems = diags.filter(d => d.problem);
    const plane = planes.effective?.plane;

    if (opts.remote) {
      const count = problems.length + planes.malformed.length;
      return {
        name: 'chat_fallback_chain', status: count > 0 ? 'warn' : 'ok',
        message: `A chat fallback chain is configured on the brain host${count > 0 ? ` and has ${count} problem(s)` : ''}. Its entries and the providers it reaches stay on the host; the host operator runs gbrain doctor --only chat_fallback_chain there.`,
        fix: { argv: ['gbrain', 'doctor', '--only', NAME], consent: [], actor: 'host_admin', requires_exclusive: false, docs: DOCS,
          why: 'Lists the chain, its config plane, the providers it reaches and per-plane removal guidance on the brain host; read-only.' },
      };
    }

    const details = chainSummary(planes, diags);
    const where = planes.malformed[0];
    if (where) {
      return { name: 'chat_fallback_chain', status: 'warn', details,
        message: `chat_fallback_chain cannot be read: ${where.error}.${planes.effective ? ` The effective chain comes from ${PLANE_LABEL[planes.effective.plane]}.` : ' No chain is walked while this value is set.'}`,
        fix: chatFallbackRemovalFix(where.plane, planes.filePath, 'Fix the value (provider:model entries, comma-separated or a JSON list) or remove it.') };
    }
    const first = problems[0];
    if (first && plane) {
      const fix = first.problem === 'no_credential' ? credentialFix(first, plane, planes.filePath)
        : first.problem === 'unpriced_under_cap' ? noPricingFix(noPricingGuidance(first.entry, 'chat'), 'cli')
        : chatFallbackRemovalFix(plane, planes.filePath, `Fix or remove the entry "${first.entry}".`);
      return { name: 'chat_fallback_chain', status: 'warn', details, fix,
        message: `chat_fallback_chain has ${problems.length} problem entr${problems.length === 1 ? 'y' : 'ies'}: ${problems.map(p => `${p.entry} (${p.problem})`).join(', ')}. ${first.detail}` };
    }

    const effective = planes.effective!;
    const providers = details.providers as string[];
    const shadowed = planes.shadowed.length
      ? ` Shadowed (ignored while this is set): ${planes.shadowed.map(s => `${s.plane} [${s.chain.join(', ')}]`).join('; ')}.` : '';
    const refusal = planes.onRefusal.value
      ? 'It falls back on errors and on refusals, so content one provider refused is sent to the next (chat_fallback_on_refusal=false stops that).'
      : `It falls back on errors only: chat_fallback_on_refusal=false (${planes.onRefusal.plane}).`;
    return {
      name: 'chat_fallback_chain', status: 'ok', details,
      message: `chat_fallback_chain is active from ${PLANE_LABEL[effective.plane]}: ${effective.chain.join(' -> ')}. Providers that receive traffic when a call's own model fails: ${providers.join(', ')}. ${refusal}${shadowed} Removal is optional; ask the user.`,
      fix: chatFallbackRemovalFix(effective.plane, planes.filePath),
    };
  } catch (e) {
    return checkError('chat_fallback_chain', 'read chat_fallback_chain', e);
  }
}

async function runChatFallbackChain(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkChatFallbackChain(connectedEngine(ctx)));
  return checks;
}

export const chatFallbackChainEntry: DoctorEntry = {
  name: 'chat_fallback_chain',
  emits: ['chat_fallback_chain'],
  run: runChatFallbackChain,
};
