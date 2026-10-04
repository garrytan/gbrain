/**
 * Agent contract v1 D3/D4 (CLI-only half): curated help specs, their renderer
 * and the typed flag-value validator built from them.
 *
 * Protects: the 7 ops-critical commands carry a curated spec whose flags the
 * acceptance registry accepts (so help never advertises a flag the CLI then
 * rejects), `--yes` is listed wherever the handler parses it, the rendered
 * help shows type/values/consent, `curatedFlagError` turns a NaN number or an
 * out-of-set enum into `invalid_params` naming the flag, the value and an
 * example (both `--flag value` and `--flag=value`, stopping at a bare `--`),
 * and the unknown-flag did-you-mean draws on the curated flags.
 * Fails when: a curated flag drifts from what the handler parses, a typed
 * flag stops being validated, or a valid / string-typed value is refused
 * (onboard's `--max-usd off`).
 * Why new: D3/D4 add the specs and the validator; the subprocess journey is
 * test/cli-help-curated.serial.test.ts. Seam: none (pure functions + lazy modules).
 */
import { describe, expect, test } from 'bun:test';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { loadCuratedHelp, renderCuratedHelp } from '../src/cli/help/render.ts';
import { curatedFlagError } from '../src/cli/help/validate.ts';
import { unknownFlagError } from '../src/cli/cli-error.ts';

const OPS_CRITICAL = ['apply-migrations', 'autopilot', 'doctor', 'import', 'onboard', 'serve', 'status'];
/** Handlers that parse `--yes` (doctor --remediate, apply-migrations parseArgs, onboard --auto). */
const PARSES_YES = ['apply-migrations', 'doctor', 'onboard'];

describe('curated help specs (D3)', () => {
  test('exactly the ops-critical commands carry a curated help module', () => {
    expect(CLI_COMMANDS.filter(r => r.help).map(r => r.name).sort()).toEqual(OPS_CRITICAL);
  });

  for (const command of OPS_CRITICAL) {
    test(`${command}: every curated flag is accepted by the generated registry and well-typed`, async () => {
      const spec = (await loadCuratedHelp(command))!;
      const accepted = new Set(CLI_FLAG_REGISTRY[command] ?? []);
      expect(spec.usage).toContain(`gbrain ${command}`);
      expect(spec.examples.length).toBeGreaterThanOrEqual(2);
      expect(spec.examples.length).toBeLessThanOrEqual(4);
      for (const e of spec.examples) expect(e.startsWith(`gbrain ${command}`)).toBe(true);
      expect(new Set(spec.flags.map(f => f.name)).size).toBe(spec.flags.length);
      for (const f of spec.flags) {
        expect(accepted.has(f.name), `${command} ${f.name} is not in the acceptance registry`).toBe(true);
        expect(f.desc.length).toBeGreaterThan(0);
        expect(f.type === 'enum' ? (f.values?.length ?? 0) > 0 : f.values === undefined).toBe(true);
      }
      expect(spec.flags.some(f => f.name === '--yes')).toBe(PARSES_YES.includes(command));
    });
  }

  test('the renderer prints usage, the typed flag table, enum values, consent effects and examples', async () => {
    const spec = (await loadCuratedHelp('doctor'))!;
    const text = renderCuratedHelp('doctor', spec);
    expect(text).toContain('Usage: gbrain doctor');
    expect(text).toMatch(/--max-usd <n>\s+number\s+.*\[consent: paid\]/);
    expect(text).toMatch(/--include-repairs\s+boolean\s+.*\[consent: destructive\]/);
    expect(text).toMatch(/--scope <choice>\s+enum\s+.*One of: all\|brain\./);
    expect(text).toContain('Examples:\n  gbrain doctor --json');
    expect(text).toContain('gbrain doctor --help --json');
  });
});

describe('curatedFlagError (D4, CLI-only commands)', () => {
  test('a non-numeric number flag is invalid_params naming the flag, the value and an example', async () => {
    const e = (await curatedFlagError('doctor', ['--remediate', '--max-usd', 'abc']))!;
    expect(e.code).toBe('invalid_params');
    expect(e.message).toBe("--max-usd must be a number; got 'abc'.");
    expect(e.suggestion).toBe('Pass a number, e.g. --max-usd 5.');
  });

  test('--flag=value and a missing value are checked too', async () => {
    expect((await curatedFlagError('doctor', ['--target-score=high']))?.message).toBe("--target-score must be a number; got 'high'.");
    expect((await curatedFlagError('import', ['./notes', '--workers']))?.message).toBe('--workers requires a value: a number.');
    expect((await curatedFlagError('import', ['./notes', '--workers', '--json']))?.message).toBe('--workers requires a value: a number.');
  });

  test('an enum value outside its set lists the valid choices', async () => {
    const e = (await curatedFlagError('status', ['--section', 'bogus']))!;
    expect(e.code).toBe('invalid_params');
    expect(e.message).toBe("--section must be one of sync|cycle|locks|workers|queue|autopilot; got 'bogus'.");
    expect(e.suggestion).toBe('Pass one of sync|cycle|locks|workers|queue|autopilot, e.g. --section sync.');
    expect((await curatedFlagError('doctor', ['--scope=nope']))?.message).toContain('one of all|brain');
  });

  test('valid values, string flags, positionals after a bare -- and uncurated commands pass', async () => {
    expect(await curatedFlagError('doctor', ['--remediate', '--yes', '--max-usd', '2.5', '--target-score=80', '--scope=brain'])).toBeNull();
    expect(await curatedFlagError('serve', ['--surface', 'starter', '--access', 'read-only', '--port', '3131'])).toBeNull();
    expect(await curatedFlagError('onboard', ['--auto', '--max-usd', 'off'])).toBeNull();
    expect(await curatedFlagError('autopilot', ['--repo', './brain', '--', '--interval', 'soon'])).toBeNull();
    expect(await curatedFlagError('doctor', ['--', '--max-usd', 'abc'])).toBeNull();
    expect(await curatedFlagError('sync', ['--interval', 'abc'])).toBeNull();
  });
});

describe('unknown-flag did-you-mean from curated flags (D3)', () => {
  test('a typo on a curated command suggests the curated flag', async () => {
    const curated = (await loadCuratedHelp('doctor'))!.flags.map(f => f.name);
    const e = unknownFlagError('doctor', '--remediat', "unknown flag --remediat for 'gbrain doctor'", curated);
    expect(e.code).toBe('unknown_flag');
    expect(e.message).toContain('did you mean --remediate?');
    expect(e.suggestion).toContain('Did you mean --remediate?');
  });
});
