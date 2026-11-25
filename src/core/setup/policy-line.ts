/**
 * The brain-first block's agent-policy line (L1). It tells the agent to call policy_check before
 * an outside action on the user's behalf, and only where that call works on this connection:
 * the CLI, the full MCP surface, or the starter surface through request_tools. The verbs surface
 * cannot reach it, so no line is written there. The ledger line (log_action) arrives with the
 * action ledger. `brain_first.policy_line` (file plane, owner-confirmed) turns it on or off; a
 * change rewrites installed blocks at the next setup or upgrade.
 */
import { loadConfigFileOnly } from '../config.ts';
import type { BrainFirstAccess } from './brain-first.ts';

export const BRAIN_FIRST_POLICY_LINE_KEY = 'brain_first.policy_line';
/**
 * Off: the uc3 quick look passed (Claude Code with Opus 5.5 and Codex with Sol called policy_check first in every run),
 * but the line would take the block past its per-turn word cap (test/setup-brain-first.test.ts), so it stays opt-in.
 */
export const POLICY_LINE_DEFAULT: 'on' | 'off' = 'off';
/** The words every rendering of the line starts with, so a block can be tested for it. */
export const POLICY_LINE_LEAD = '- Outside actions:';

export function readPolicyLineSetting(): { value: 'on' | 'off'; source: 'config' | 'default' } {
  let raw: string | undefined;
  try { raw = loadConfigFileOnly()?.brain_first?.policy_line; } catch { raw = undefined; } // silent-read-ok: an unreadable config file leaves the line at its default (off), the conservative value; config doctor reports the file
  return raw === 'on' || raw === 'off' ? { value: raw, source: 'config' } : { value: POLICY_LINE_DEFAULT, source: 'default' };
}

const code = (s: string) => '`' + s + '`';

/** The line for this access, or null when policy_check is not reachable on it. */
export function renderPolicyLine(access: BrainFirstAccess): string | null {
  let call: string | null;
  if (access.kind === 'cli') call = `run ${code(`${access.launcher} policy check <verb>`)} (add ${code('--amount 60 --currency USD')}, ${code('--merchant <name>')} or ${code('--to new')} when they apply)`;
  else if (access.surface === 'verbs') call = null;
  else if (access.surface === 'starter') call = `call ${code('policy_check')} on the ${code(access.server)} MCP server (if it is not in your tool list, ${code('request_tools {"surface":"full"}')} adds it)`;
  else call = `call ${code('policy_check')} on the ${code(access.server)} MCP server`;
  if (!call) return null;
  return `${POLICY_LINE_LEAD} before you send, spend, delete, sign up, call or publish on the user's behalf outside this repository (money, messages, accounts, sign-ups), ${call} and follow its decision. `
    + 'It is advice: keep your harness\'s own approvals, and ask the user when it says ask. Coding pushes and repository work are out of scope.';
}

/** The line the block carries now: null when the setting is off or the access cannot reach policy_check. */
export function policyLineFor(access: BrainFirstAccess): string | null {
  return readPolicyLineSetting().value === 'on' ? renderPolicyLine(access) : null;
}
