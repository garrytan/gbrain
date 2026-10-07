// #4907 / #4906: synthesize_concepts reads `cycle.synthesize_concepts.budget_usd`.
//
// Protects: an operator's concept budget is the cap the phase enforces (the
// pre-call refusal at `estimatedSpendUsd >= budgetCap`, the pricing-fallback
// message and `details.budget_usd`), an invalid stored value is named instead
// of silently ignored, a budget-capped run says so, and `config set` refuses a
// value the phase would ignore.
// Fails when: the phase keeps the hardcoded $1.50 cap, drops the named-key
// warning, or `config set` writes a non-positive budget.
// Why new: the phase had no config read; the stub engine implements
// `readPageSnapshot` (the phase reads each concept page before any spend), so
// the phase runs to the cap under test rather than throwing first.
//
// The real phase runs through its `_chat` / `_atoms` seams under `dryRun`:
// nothing is written and no provider is called.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { parsePhaseConfigValue, SYNTHESIZE_CONCEPTS_BUDGET_KEY } from '../src/core/cycle/phase-config-values.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

const KEY = SYNTHESIZE_CONCEPTS_BUDGET_KEY;

/** Three T1 groups (>= 10 atoms each), so every one is LLM-eligible. */
function atoms(groups = 3, per = 10) {
  const out: Array<{ slug: string; concept_refs: string[]; body: string; title: string }> = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < per; i++) {
      out.push({ slug: `atoms/2026-09-05/g${g}-a${i}`, concept_refs: [`concept-${g}`], title: `atom ${g}.${i}`, body: `body of atom ${g}.${i}` });
    }
  }
  return out;
}

/** Each answer costs $0.90 at the Sonnet fallback rate (300k input tokens at $3/M). */
function countingChat() {
  const calls = { n: 0 };
  const chat = (async () => {
    calls.n++;
    return { model: 'test:unpriced-model', text: 'a synthesized narrative.', usage: { input_tokens: 300_000, output_tokens: 0 } };
  }) as never;
  return { calls, chat };
}

function engineWith(configured: string | null | (() => never)) {
  return {
    getConfig: async (k: string) => {
      if (k !== KEY) return null;
      return typeof configured === 'function' ? configured() : configured;
    },
    readPageSnapshot: async () => null,
  } as never;
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), stderr: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

async function run(configured: string | null | (() => never)) {
  const { calls, chat } = countingChat();
  const { value: r, stderr } = await captureStderr(() =>
    runPhaseSynthesizeConcepts(engineWith(configured), { dryRun: true, _atoms: atoms(), _chat: chat } as never));
  const details = r.details as Record<string, unknown>;
  return {
    r, stderr, calls: calls.n, details,
    modes: details.synthesis_mode_counts as Record<string, number>,
    warnings: details.warnings as string[],
  };
}

describe('synthesize_concepts budget comes from cycle.synthesize_concepts.budget_usd', () => {
  test('unset keeps the $1.50 default: the call that crosses it runs, the next group is refused before any call', async () => {
    const out = await run(null);
    expect(out.calls).toBe(2);
    expect(out.modes.llm).toBe(2);
    expect(out.modes.budget_fallback).toBe(1);
    expect(out.details.budget_usd).toBe(1.5);
  });

  test('a larger configured budget is the cap the phase enforces and meters against', async () => {
    const out = await run('20');
    expect(out.calls).toBe(3);
    expect(out.modes.llm).toBe(3);
    expect(out.modes.budget_fallback).toBe(0);
    expect(out.details.budget_usd).toBe(20);
    expect(out.stderr).toContain('against the $20.00 phase budget');
    expect(out.warnings).toEqual([]);
  });

  test('a smaller configured budget stops spend earlier: no provider call past the cap', async () => {
    const out = await run('0.5');
    expect(out.calls).toBe(1);
    expect(out.modes.llm).toBe(1);
    expect(out.modes.budget_fallback).toBe(2);
    expect(out.details.budget_usd).toBe(0.5);
    expect(out.stderr).toContain('against the $0.50 phase budget');
  });

  for (const bad of ['not-a-number', '0', '-7.25', 'Infinity']) {
    test(`a stored ${JSON.stringify(bad)} keeps the default and names the key without echoing the value`, async () => {
      const out = await run(bad);
      expect(out.calls).toBe(2);
      expect(out.details.budget_usd).toBe(1.5);
      const warning = out.warnings.find((w) => w.includes('invalid value'));
      expect(warning).toContain(KEY);
      expect(warning).toContain(`gbrain config set ${KEY}`);
      expect(warning).toContain(`gbrain config get ${KEY}`);
      if (bad !== '0') expect(warning).not.toContain(bad);
      expect(out.stderr).toContain(`${KEY} is set to an invalid value`);
    });
  }

  test('a budget-capped run is loud: the summary and warnings name the cap and the key', async () => {
    const out = await run(null);
    expect(out.r.summary).toContain('1 over the $1.50 budget → template fallback');
    const capped = out.warnings.find((w) => w.includes('phase budget was reached'));
    expect(capped).toContain('1 LLM-eligible concept(s)');
    expect(capped).toContain(`gbrain config set ${KEY} <usd>`);
    expect(out.stderr).toContain('phase budget was reached');
  });

  test('a getConfig that throws keeps the default and does not stop the phase', async () => {
    const out = await run(() => { throw new Error('config plane down'); });
    expect(out.r.status).not.toBe('error');
    expect(out.details.budget_usd).toBe(1.5);
  });
});

describe('config set validation for cycle.synthesize_concepts.budget_usd', () => {
  test('the key is registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(KEY);
  });

  test('a finite positive value is accepted', () => {
    expect(parsePhaseConfigValue(KEY, '20')).toBe(20);
    expect(parsePhaseConfigValue(KEY, '0.25')).toBe(0.25);
  });

  for (const bad of ['0', '-7.25', 'NaN', 'Infinity', 'twenty', ' ']) {
    test(`${JSON.stringify(bad)} is refused with the rendered contract and never echoed`, () => {
      let err: unknown;
      try { parsePhaseConfigValue(KEY, bad); } catch (e) { err = e; }
      const rendered = renderCliError(err, { json: true, command: 'config', tty: false });
      expect(rendered.exitCode).toBe(2);
      const env = JSON.parse(rendered.stdout!);
      expect(env).toMatchObject({
        code: 'invalid_params',
        fix: { argv: ['gbrain', 'config', 'set', KEY, '<VALUE>'], verify: { argv: ['gbrain', 'config', 'get', KEY] } },
      });
      expect(env.message).toContain(KEY);
      expect(env.why).toContain('Nothing was written');
      expect(env.fix.next).toBeTruthy();
      if (bad.trim().length > 1) expect(rendered.stdout).not.toContain(bad);
    });
  }
});

describe('gbrain config set refuses a non-positive budget before writing', () => {
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-concepts-budget-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }) + '\n');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
  }, 240_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('exit 2 with the rendered invalid_params refusal, and the key stays unset', async () => {
    const set = await runCli(['config', 'set', KEY, '0'], { home, timeoutMs: 120_000 });
    expect(set.exitCode).toBe(2);
    expect(set.stderr).toContain(`Error [invalid_params]: Invalid ${KEY}`);
    expect(set.stderr).toContain(`Fix: gbrain config set ${KEY}`);
    expect(set.stderr).toContain('Why: ');
    expect(set.stdout).not.toContain('Set ');
    const get = await runCli(['config', 'get', KEY], { home, timeoutMs: 120_000 });
    expect(get.exitCode).not.toBe(0);
    expect(get.stdout.trim()).toBe('');
  }, 300_000);
});
