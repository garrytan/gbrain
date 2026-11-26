/**
 * Reserved config keys (agent policy, L1): `policy.approved.*` (the owner's policy approvals) and
 * `brain_first.*` (what the brain-first block tells agents). `config set|unset` never writes an
 * approval: only `gbrain policy` does, after the owner confirms. A brain_first setting changes
 * only after the owner confirms it at their own terminal, in a process with no agent marker.
 * Handled before any engine is opened.
 */
import { createHash } from 'node:crypto';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { writeCliError } from '../../cli/cli-error.ts';
import { opError, OperationError } from '../../core/ops/contract.ts';
import { assertConfigKeyWritable, BRAIN_FIRST_CONFIG_PREFIX, confirmOnTerminal, POLICY_APPROVAL_PREFIX, withOwnerProof } from '../../core/policy/authority.ts';
import { BRAIN_FIRST_POLICY_LINE_KEY, readPolicyLineSetting } from '../../core/setup/policy-line.ts';

const RESERVED_PREFIXES = [POLICY_APPROVAL_PREFIX, BRAIN_FIRST_CONFIG_PREFIX];

/** A `--pattern` prefix covers a reserved key when either one is a prefix of the other. */
function patternCoversReserved(prefix: string): boolean {
  return RESERVED_PREFIXES.some(r => r.startsWith(prefix) || prefix.startsWith(r));
}

function fail(error: OperationError, argv: string[]): true {
  setCliExitVerdict(writeCliError(error, 'config', { argv: ['config', ...argv] }));
  return true;
}

/** Returns true when the args named a reserved key and this handled them (written, or refused with the exit verdict set). */
export async function runReservedConfigKey(args: string[]): Promise<boolean> {
  const action = args[0];
  if (action !== 'set' && action !== 'unset') return false;
  const patternAt = action === 'unset' ? args.indexOf('--pattern') : -1;
  if (patternAt >= 0) {
    const prefix = args[patternAt + 1];
    if (prefix === undefined || !patternCoversReserved(prefix)) return false;
    return fail(opError('policy_approval_reserved', `The pattern "${prefix}" covers reserved policy keys (${RESERVED_PREFIXES.join(', ')}), so nothing was deleted.`,
      'Use a narrower pattern; policy approvals change only through gbrain policy, run by the owner.'), args);
  }
  const key = args.filter(a => a !== '--raw')[1];
  if (!key || !RESERVED_PREFIXES.some(r => key.startsWith(r))) return false;
  try {
    if (key.startsWith(POLICY_APPROVAL_PREFIX)) assertConfigKeyWritable(key);
    if (key !== BRAIN_FIRST_POLICY_LINE_KEY) {
      throw opError('invalid_params', `Unknown config key ${key}.`, `The one brain_first setting is ${BRAIN_FIRST_POLICY_LINE_KEY} (on or off).`);
    }
    const value = action === 'unset' ? null : args.slice(2).find(a => !a.startsWith('-')) ?? null;
    if (action === 'set' && value !== 'on' && value !== 'off') {
      throw opError('invalid_params', `${key} takes on or off, not ${value ?? '(nothing)'}.`, `Run gbrain config set ${key} off to drop the policy line from your agents' instructions.`);
    }
    const before = readPolicyLineSetting().value;
    const argv = action === 'unset' ? ['gbrain', 'config', 'unset', key] : ['gbrain', 'config', 'set', key, value!];
    const digest = createHash('sha256').update(`${key}=${value ?? ''}`).digest('hex');
    const proof = await confirmOnTerminal({ argv, digest, summary: [`${key}: ${before} → ${value ?? 'the default'}`,
      'This decides whether your agents\' brain-first instructions tell them to call policy_check before outside actions. It applies at the next gbrain setup or upgrade.'] });
    await withOwnerProof(proof, async () => {
      const { loadConfigFileOnly, saveConfig } = await import('../../core/config.ts');
      const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
      const next = { ...(cfg.brain_first ?? {}) };
      if (value === null) delete next.policy_line; else next.policy_line = value;
      cfg.brain_first = next;
      saveConfig(cfg);
    });
    console.log(`${action === 'unset' ? 'Unset' : 'Set'} ${key}${value ? ` = ${value}` : ''} (file plane: ~/.gbrain/config.json). Run gbrain setup <harness> --instructions-only, or wait for the next upgrade, to rewrite the instruction block.`);
    return true;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return fail(error, args);
  }
}
