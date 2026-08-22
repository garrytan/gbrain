/**
 * #4198 — `gbrain eval synthesize-concepts` routing regression.
 *
 * Pre-fix there was NO dispatch branch for the subcommand: it fell through
 * to the generic qrels eval and died with "Error: --qrels <path|json> is
 * required", while the programmatic scaffold reported ok:true — a scripted
 * caller could read "pass" from a command that evaluated nothing.
 *
 * Pins:
 *   1. the CLI entry returns nonzero with an honest not_implemented envelope
 *   2. --help exits 0 with a dedicated help text (not the qrels help)
 *   3. subprocess smoke: the real CLI routes the subcommand to the scaffold
 *      (never the qrels flow) and propagates exit 1
 *   4. source pin: both dispatch layers (cli.ts pre-engine + eval.ts
 *      re-entry) carry the branch, so neither refactor can silently hand the
 *      subcommand back to the qrels flow
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  runEvalSynthesizeConcepts,
  runEvalSynthesizeConceptsCli,
} from '../src/commands/eval-synthesize-concepts.ts';

describe('CLI entry (unit)', () => {
  test('--help exits 0 with dedicated help, no qrels text', async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: unknown) => {
      lines.push(String(s));
    };
    try {
      const code = await runEvalSynthesizeConceptsCli(['--help']);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }
    const out = lines.join('\n');
    expect(out).toContain('synthesize-concepts');
    expect(out).toContain('NOT IMPLEMENTED');
    expect(out).not.toContain('--qrels');
  });

  test('--json exits 1 with ok:false / status not_implemented', async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (s: unknown) => {
      lines.push(String(s));
    };
    try {
      const code = await runEvalSynthesizeConceptsCli([
        '--json',
        '--parity-baseline',
        '/tmp/concepts',
        '--sample',
        '250',
      ]);
      expect(code).toBe(1);
    } finally {
      console.log = origLog;
    }
    const envelope = JSON.parse(lines.join('\n'));
    expect(envelope.schema_version).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('not_implemented');
    expect(envelope.details.parity_baseline_path).toBe('/tmp/concepts');
    expect(envelope.details.sample_size).toBe(250);
  });

  test('programmatic scaffold never reads as a pass', async () => {
    const r = await runEvalSynthesizeConcepts({});
    expect(r.ok).toBe(false);
    expect(r.status).toBe('not_implemented');
  });
});

describe('dispatch-layer source pins (routing can’t regress silently)', () => {
  test('cli.ts carries the dedicated pre-engine branch', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("command === 'eval' && args[0] === 'synthesize-concepts'");
    expect(src).toContain('runEvalSynthesizeConceptsCli');
  });

  test('eval.ts re-entry branch precedes the generic qrels flow', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/commands/eval.ts', import.meta.url)),
      'utf8',
    );
    const branchIdx = src.indexOf("sub === 'synthesize-concepts'");
    const qrelsIdx = src.indexOf('--qrels <path|json> is required');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(qrelsIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(qrelsIdx);
  });
});

describe('subprocess smoke — end-to-end routing', () => {
  test('eval synthesize-concepts --json exits 1 with the envelope, never the qrels error', () => {
    const r = spawnSync('bun', ['src/cli.ts', 'eval', 'synthesize-concepts', '--json'], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('--qrels');
    const jsonStart = r.stdout.indexOf('{');
    expect(jsonStart).toBeGreaterThan(-1);
    const envelope = JSON.parse(r.stdout.slice(jsonStart));
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe('not_implemented');
  }, 90_000);
});
