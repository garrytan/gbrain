/**
 * GBRA-224: every install surface routes through one ref, INSTALL_REF (src/core/install-ref.ts).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { INSTALL_PIN, INSTALL_RAW_BASE, INSTALL_REF } from '../src/core/install-ref.ts';
import { driftIn, findInstallRefDrift, rewriteText } from '../scripts/check-install-ref.ts';

const ROOT = join(import.meta.dir, '..');

describe('install ref lint', () => {
  test('the constant is stable, the channel a new install follows by default', () => {
    expect(INSTALL_REF).toBe('stable');
    expect(INSTALL_PIN).toBe('github:aimonk2025/gbrain#stable');
    expect(INSTALL_RAW_BASE).toBe('https://raw.githubusercontent.com/aimonk2025/gbrain/stable');
  });

  test('the repository has no install surface off the constant', () => {
    expect(findInstallRefDrift(ROOT).map(d => `${d.file}:${d.line} ${d.found}`)).toEqual([]);
  });

  test('docs: a master or other named pin, or a runbook or helper fetch off the ref, is drift; exact pins are not', () => {
    const doc = [
      'bun install -g github:aimonk2025/gbrain#master',
      'bun install -g github:aimonk2025/gbrain#stable',
      'bun add -g github:aimonk2025/gbrain#v0.60.1.0 and github:aimonk2025/gbrain#v${VERSION}',
      'curl https://raw.githubusercontent.com/aimonk2025/gbrain/master/BOOTSTRAP_FOR_AGENTS.md',
      'curl https://raw.githubusercontent.com/aimonk2025/gbrain/main/scripts/setup-in-agent.sh',
      'read https://raw.githubusercontent.com/aimonk2025/gbrain/master/INSTALL_FOR_AGENTS.md',
      'bun install -g github:aimonk2025/gbrain#latest-stable',
    ].join('\n');
    expect(driftIn('docs/x.md', doc, 'latest-stable').map(d => [d.line, d.found])).toEqual([
      [1, 'github:aimonk2025/gbrain#master'],
      [2, 'github:aimonk2025/gbrain#stable'],
      [4, 'raw.githubusercontent.com/aimonk2025/gbrain/master/BOOTSTRAP_FOR_AGENTS.md'],
      [5, 'raw.githubusercontent.com/aimonk2025/gbrain/main/scripts/setup-in-agent.sh'],
    ]);
    expect(driftIn('docs/x.md', doc).map(d => d.line).sort()).toEqual([1, 4, 5, 7]);
    expect(driftIn('CHANGELOG.md', doc)).toEqual([]);
    expect(driftIn('docs/x.md', `bun add -g github:aimonk2025/gbrain#${'d'.repeat(40)}\nbun add -g github:aimonk2025/gbrain#abc1234\n`)).toEqual([]);
    expect(rewriteText('docs/x.md', `github:aimonk2025/gbrain#${'a'.repeat(40)}`, 'stable')).toBe(`github:aimonk2025/gbrain#${'a'.repeat(40)}`);
  });

  test('TypeScript never spells an install ref; it imports the constant', () => {
    expect(driftIn('src/x.ts', "const a = 'bun install -g github:aimonk2025/gbrain#latest-stable';")).toHaveLength(1);
    expect(driftIn('src/x.ts', "const u = 'https://raw.githubusercontent.com/aimonk2025/gbrain/latest-stable/BOOTSTRAP_FOR_AGENTS.md';")).toHaveLength(1);
    expect(driftIn('src/x.ts', 'const a = `github:aimonk2025/gbrain#v${v}`; const b = INSTALL_PIN;')).toEqual([]);
  });

  test('behavior-changes.d rows are held to the TypeScript rule, because the release folds their text into TypeScript', () => {
    const row = 'Run bun install -g github:aimonk2025/gbrain#stable, then fetch https://raw.githubusercontent.com/aimonk2025/gbrain/stable/BOOTSTRAP_FOR_AGENTS.md\n';
    expect(driftIn('behavior-changes.d/x_1.md', row, 'stable')).toHaveLength(2);
    expect(rewriteText('behavior-changes.d/x_1.md', row, 'stable')).toBe(row);
    expect(driftIn('behavior-changes.d/README.md', row, 'stable')).toEqual([]);
  });

  test('the setup helper resolves the constant, and --write flips every text surface in one pass', () => {
    expect(driftIn('scripts/setup-in-agent.sh', 'gbrain_install_ref=master\n')).toHaveLength(1);
    const doc = 'github:aimonk2025/gbrain#latest-stable\nraw.githubusercontent.com/aimonk2025/gbrain/latest-stable/BOOTSTRAP_FOR_AGENTS.md\ngbrain_install_ref=latest-stable\ngithub:aimonk2025/gbrain#v1.2.3.4\n';
    const flipped = rewriteText('README.md', doc, 'stable');
    expect(flipped).toBe('github:aimonk2025/gbrain#stable\nraw.githubusercontent.com/aimonk2025/gbrain/stable/BOOTSTRAP_FOR_AGENTS.md\ngbrain_install_ref=stable\ngithub:aimonk2025/gbrain#v1.2.3.4\n');
    expect(driftIn('README.md', flipped, 'stable')).toEqual([]);
    expect(rewriteText('src/x.ts', doc, 'stable')).toBe(doc);
  });
});
