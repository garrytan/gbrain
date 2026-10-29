/**
 * The streamed conversation generator (test/helpers/conversation-stream.ts; Wave C PR 1G).
 *
 * 1. Protects: the file is exactly the requested size and ends in a newline, the returned sha256 is the file's, each of
 *    the 10 needles sits at its recorded offset inside its own tenth of the file and occurs once, the same seed writes
 *    the same bytes and another seed different ones, and the frontmatter parses as a note.
 * 2. Fails when: any of those regress. The 64 MiB keyword probes and the flat-memory check:
 *    test/large-pages/conversation-stream-probes.slow.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMarkdown } from '../src/core/markdown.ts';
import { conversationTurns, writeConversationFile } from './helpers/conversation-stream.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-conversation-stream-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('streamed conversation generator', () => {
  test('exact size, its own sha256, one needle per tenth at its offset, deterministic per seed', () => {
    for (const bytes of [64 * 1024, 1024 ** 2 - 1, 1024 ** 2, 1024 ** 2 + 1, 3 * 1024 ** 2 + 17]) {
      const file = writeConversationFile(join(dir, `a-${bytes}.md`), bytes, 7);
      const raw = readFileSync(file.path);
      expect(raw.length).toBe(bytes);
      expect(raw.at(-1)).toBe(0x0a);
      expect(file.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
      expect(file.needles.map(needle => needle.decile)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (const needle of file.needles) {
        expect(needle.word).toBe(`gbneedle${needle.decile}s7`);
        expect(raw.toString('latin1', needle.offset, needle.offset + needle.word.length)).toBe(needle.word);
        expect(raw.indexOf(needle.word)).toBe(needle.offset);
        expect(raw.lastIndexOf(needle.word)).toBe(needle.offset);
        expect(needle.offset).toBeGreaterThanOrEqual(Math.floor(bytes * needle.decile / 10));
        expect(needle.offset).toBeLessThan(Math.floor(bytes * (needle.decile + 1) / 10));
      }
      const again = writeConversationFile(join(dir, `b-${bytes}.md`), bytes, 7);
      expect({ sha256: again.sha256, needles: again.needles }).toEqual({ sha256: file.sha256, needles: file.needles });
      expect(writeConversationFile(join(dir, `c-${bytes}.md`), bytes, 8).sha256).not.toBe(file.sha256);
      const parsed = parseMarkdown(raw.toString('utf8'), 'notes/stream.md');
      expect({ title: parsed.title, type: parsed.type }).toEqual({ title: 'Conversation log 7', type: 'note' });
    }
  });

  test('turns are seeded, carry a given needle as one word, and use placeholder speakers only', () => {
    const [a, b] = [conversationTurns(3), conversationTurns(3)];
    const turns = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(turns);
    expect(turns.join('')).toMatch(/^## Day 1\n\n/);
    expect(new Set(turns.flatMap(turn => [...turn.matchAll(/\*\*([^*]+)\*\*:/g)].map(match => match[1])))).toEqual(new Set(['alice-example', 'bob-example', 'carol-example']));
    expect(a('gbneedlex').split(/\s|\./).filter(word => word === 'gbneedlex')).toHaveLength(1);
  });

  test('refuses a size below the 64 KiB floor', () => {
    expect(() => writeConversationFile(join(dir, 'tiny.md'), 1000, 1)).toThrow(RangeError);
  });
});
