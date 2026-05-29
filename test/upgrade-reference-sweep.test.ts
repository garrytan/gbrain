/**
 * Tests for `postUpgradeReferenceSweep` in src/commands/upgrade.ts —
 * the v0.36 hook that prints a one-line-per-skill summary of drift
 * after `cortex upgrade` so an operator/agent doesn't have to manually
 * run `cortex skillpack reference --all`.
 *
 * Pins:
 *   - CORTEX_SKIP_REFERENCE_SWEEP=1 short-circuits silently
 *   - no detected workspace → silent no-op
 *   - workspace == Cortex repo (dev mode) -> silent no-op
 *   - zero drift (everything identical or never-scaffolded) → silent
 *   - drift detected → prints header + per-skill summary + footer hints
 *   - non-scaffolded skills (pure missing) suppressed from the summary
 *
 * The function is exported from upgrade.ts so we can drive it without
 * spawning a full `cortex upgrade` subprocess. We swap the cwd via
 * process.chdir() to control what autoDetectSkillsDirReadOnly returns.
 */

import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { postUpgradeReferenceSweep } from '../src/commands/upgrade.ts';
import { withEnv } from './helpers/with-env.ts';

const created: string[] = [];
let origCwd: string;
let logs: string[];
let originalConsoleLog: typeof console.log;

beforeEach(() => {
  origCwd = process.cwd();
  logs = [];
  originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
});

afterEach(() => {
  process.chdir(origCwd);
  console.log = originalConsoleLog;
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchHostWithSkill(slug: string, opts: { drift?: boolean } = {}): string {
  // Set up a fixture host workspace with one scaffolded skill that either
  // matches Cortex's bundle (identical) or diverges (drift).
  const ws = mkdtempSync(join(tmpdir(), 'ups-host-'));
  created.push(ws);
  mkdirSync(join(ws, 'skills', slug), { recursive: true });
  // The real Cortex bundle ships skills/<slug>/SKILL.md. Write a copy here.
  // For drift, write a different version.
  const realSkill = join(process.cwd(), 'skills', slug, 'SKILL.md');
  if (!existsSync(realSkill)) {
    throw new Error(`fixture precondition: Cortex repo must have ${realSkill}`);
  }
  const real = require('fs').readFileSync(realSkill, 'utf-8');
  const content = opts.drift ? real + '\n## local edit\n' : real;
  writeFileSync(join(ws, 'skills', slug, 'SKILL.md'), content);
  return ws;
}

function scratchEmptyHost(): string {
  // Empty `skills/` dir — host detected but never scaffolded anything.
  // Reference --all would report every bundled skill as `missing:N`. The
  // sweep should suppress these (they're noise — the host never wanted
  // them).
  const ws = mkdtempSync(join(tmpdir(), 'ups-empty-'));
  created.push(ws);
  mkdirSync(join(ws, 'skills'), { recursive: true });
  return ws;
}

const CORTEX_ROOT = process.cwd(); // tests run from Cortex repo root

describe('postUpgradeReferenceSweep', () => {
  it('CORTEX_SKIP_REFERENCE_SWEEP=1 short-circuits silently', async () => {
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: '1' }, async () => {
      const ws = scratchHostWithSkill('setup', { drift: true });
      await postUpgradeReferenceSweep({ cortexRoot: CORTEX_ROOT, targetWorkspace: ws });
      expect(logs.join('\n')).toBe('');
    });
  });

  it('zero drift (skills present but identical) → silent', async () => {
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: undefined }, async () => {
      const ws = scratchHostWithSkill('setup'); // no drift
      await postUpgradeReferenceSweep({ cortexRoot: CORTEX_ROOT, targetWorkspace: ws });
      expect(logs.join('\n')).not.toContain('Skillpack reference sweep');
    });
  });

  it('empty skills/ dir (never scaffolded) → silent (no noise)', async () => {
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: undefined }, async () => {
      const ws = scratchEmptyHost();
      await postUpgradeReferenceSweep({ cortexRoot: CORTEX_ROOT, targetWorkspace: ws });
      // Every bundled skill reports missing-only — filter requires
      // identical+differs > 0, so all are suppressed. Header never prints.
      expect(logs.join('\n')).not.toContain('Skillpack reference sweep');
    });
  });

  it('drift detected → prints header + per-skill summary + footer hints', async () => {
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: undefined }, async () => {
      const ws = scratchHostWithSkill('setup', { drift: true });
      await postUpgradeReferenceSweep({ cortexRoot: CORTEX_ROOT, targetWorkspace: ws });
      const out = logs.join('\n');
      expect(out).toContain('Skillpack reference sweep');
      expect(out).toContain('setup');
      expect(out).toContain('differs:1'); // the one edited file
      expect(out).toContain('cortex skillpack reference <slug>');
      expect(out).toContain('_AGENT_README.md');
      expect(out).toContain('CORTEX_SKIP_REFERENCE_SWEEP');
    });
  });

  it('dev-mode guard: workspace IS Cortex -> silent', async () => {
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: undefined }, async () => {
      // Pass Cortex repo as both cortexRoot AND targetWorkspace.
      await postUpgradeReferenceSweep({
        cortexRoot: CORTEX_ROOT,
        targetWorkspace: CORTEX_ROOT,
      });
      expect(logs.join('\n')).not.toContain('Skillpack reference sweep');
    });
  });

  it('errors swallowed silently — never blocks post-upgrade', async () => {
    // Pass a bogus path. The internal runReferenceAll will throw because
    // the bundle manifest doesn't exist at that path. Sweep must catch.
    await withEnv({ CORTEX_SKIP_REFERENCE_SWEEP: undefined }, async () => {
      await postUpgradeReferenceSweep({
        cortexRoot: '/dev/null/no-bundle-here',
        targetWorkspace: '/tmp/no-such-workspace',
      });
      // Must not throw. Logs may or may not have content; either is fine.
    });
  });
});
