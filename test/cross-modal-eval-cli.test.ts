import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  describeReceiptStatus,
  findReceiptForSkill,
  inferSlugFromSkillPath,
  isReceiptFile,
  listReceiptsForSlug,
  receiptName,
  sha8,
} from '../src/core/cross-modal-eval/receipt-name.ts';
import { writeReceipt } from '../src/core/cross-modal-eval/receipt-write.ts';
import { withEnv } from './helpers/with-env.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-cme-cli-'));
}

describe('cross-modal-eval CLI helpers', () => {
  test('sha8 is deterministic and 8 hex chars', () => {
    const a = sha8('hello world');
    const b = sha8('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(sha8('different')).not.toBe(a);
  });

  test('receiptName: <slug>-<sha8>.json shape', () => {
    const name = receiptName('my-skill', '# SKILL.md content');
    expect(name).toMatch(/^my-skill-[0-9a-f]{8}\.json$/);
    const expected = `my-skill-${sha8('# SKILL.md content')}.json`;
    expect(name).toBe(expected);
  });

  test('receiptName rejects invalid slug', () => {
    expect(() => receiptName('Bad Slug', 'x')).toThrow();
    expect(() => receiptName('', 'x')).toThrow();
    expect(() => receiptName('../escape', 'x')).toThrow();
  });

  test('inferSlugFromSkillPath: pulls parent directory name', () => {
    expect(inferSlugFromSkillPath('skills/my-skill/SKILL.md')).toBe('my-skill');
    expect(inferSlugFromSkillPath('/abs/path/skills/foo-bar/SKILL.md')).toBe('foo-bar');
    expect(() => inferSlugFromSkillPath('skills/my-skill/notes.md')).toThrow();
    expect(() => inferSlugFromSkillPath('SKILL.md')).toThrow();
  });

  test('findReceiptForSkill: missing skill -> missing', () => {
    const dir = makeTempDir();
    try {
      const result = findReceiptForSkill(join(dir, 'skills', 'nope', 'SKILL.md'), join(dir, 'receipts'));
      expect(result.status).toBe('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findReceiptForSkill: found when sha matches', () => {
    const dir = makeTempDir();
    try {
      const skillDir = join(dir, 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      const content = '# demo skill\n';
      writeFileSync(skillPath, content);

      const receiptDir = join(dir, 'receipts');
      mkdirSync(receiptDir, { recursive: true });
      const expected = receiptName('demo', content);
      writeFileSync(join(receiptDir, expected), '{"schema_version":1}');

      const status = findReceiptForSkill(skillPath, receiptDir);
      expect(status.status).toBe('found');
      if (status.status === 'found') {
        expect(status.path.endsWith(expected)).toBe(true);
        expect(status.sha).toBe(sha8(content));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findReceiptForSkill: stale when sha mismatches', () => {
    const dir = makeTempDir();
    try {
      const skillDir = join(dir, 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      writeFileSync(skillPath, '# updated content\n');

      const receiptDir = join(dir, 'receipts');
      mkdirSync(receiptDir, { recursive: true });
      const oldSha = sha8('# original content\n');
      writeFileSync(join(receiptDir, `demo-${oldSha}.json`), '{"schema_version":1}');

      const status = findReceiptForSkill(skillPath, receiptDir);
      expect(status.status).toBe('stale');
      if (status.status === 'stale') {
        expect(status.latestSha).toBe(oldSha);
        expect(status.currentSha).toBe(sha8('# updated content\n'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('describeReceiptStatus: human-readable string for each status', () => {
    const found = describeReceiptStatus('demo', { status: 'found', path: '/r/demo-aabbccdd.json', sha: 'aabbccdd' });
    expect(found).toContain('found');
    expect(found).toContain('demo');

    const stale = describeReceiptStatus('demo', {
      status: 'stale',
      latestPath: '/r/demo-old.json',
      latestSha: 'old-sha',
      currentSha: 'new-sha',
    });
    expect(stale).toContain('older');
    expect(stale).toContain('Re-run');

    const missing = describeReceiptStatus('demo', { status: 'missing', currentSha: 'x' });
    expect(missing).toContain('no cross-modal eval receipt');
  });

  test('listReceiptsForSlug returns newest first', () => {
    const dir = makeTempDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'demo-11111111.json'), '{}');
      // Sleep tiny so mtimes differ on filesystems with low resolution.
      const start = Date.now();
      while (Date.now() - start < 10) {
        // tight spin
      }
      writeFileSync(join(dir, 'demo-22222222.json'), '{}');
      const list = listReceiptsForSlug('demo', dir);
      expect(list).toHaveLength(2);
      expect(list[0]!.endsWith('22222222.json')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('isReceiptFile recognizes pattern', () => {
    expect(isReceiptFile('demo-aabbccdd.json')).toBe(true);
    expect(isReceiptFile('/some/dir/my-skill-12345678.json')).toBe(true);
    expect(isReceiptFile('demo.json')).toBe(false);
    expect(isReceiptFile('demo-toolong.json')).toBe(false);
    expect(isReceiptFile('not a receipt')).toBe(false);
  });

  test('writeReceipt auto-mkdirs parent (T5 correction)', () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'nested', 'deeper', 'demo-aabbccdd.json');
      expect(existsSync(target)).toBe(false);
      writeReceipt(target, { hello: 'world' });
      expect(existsSync(target)).toBe(true);
      const body = JSON.parse(readFileSync(target, 'utf-8'));
      expect(body).toEqual({ hello: 'world' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeReceipt accepts pre-stringified content', () => {
    const dir = makeTempDir();
    try {
      const target = join(dir, 'demo-aabbccdd.json');
      writeReceipt(target, '{"already":"json"}');
      const body = readFileSync(target, 'utf-8');
      expect(body).toBe('{"already":"json"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GBRAIN_HOME isolates receipts under <home>/.gbrain/eval-receipts', async () => {
    const dir = makeTempDir();
    try {
      await withEnv({ GBRAIN_HOME: dir }, async () => {
        const { gbrainPath } = await import('../src/core/config.ts');
        const path = gbrainPath('eval-receipts');
        expect(path.startsWith(dir)).toBe(true);
        expect(path.endsWith('eval-receipts')).toBe(true);
        expect(path.includes('.gbrain')).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
