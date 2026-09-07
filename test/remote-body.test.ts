import { describe, expect, test } from 'bun:test';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

function facts(world: string, privateClaim: string): string {
  return renderFactsTable([
    { rowNum: 1, claim: world, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: privateClaim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ]);
}

describe('strict remote body sanitizer', () => {
  test('ordinary Markdown is unchanged', () => {
    const body = '# Public page\n\nOrdinary prose with `code` and a [link](https://example.com).\n';
    expect(sanitizeRemoteBody(body)).toBe(body);
    expect(sanitizeRemoteBody('')).toBe('');
  });

  test('closing markers outside protected blocks remain ordinary text', () => {
    const body = `before\n${FACTS_FENCE_END}\n${TAKES_FENCE_END}\nafter`;
    expect(sanitizeRemoteBody(body)).toBe(body);
  });

  test('many protected blocks do not repeatedly scan the remaining body', () => {
    // Under 1 MB (the import cap is 5 MB). Repeated searches for the absent
    // Facts markers took seconds here; a forward scan has ample headroom.
    const blockCount = 16_000;
    const body = `${TAKES_FENCE_BEGIN}\nx\n${TAKES_FENCE_END}\n`.repeat(blockCount);
    const start = performance.now();
    const result = sanitizeRemoteBody(body);
    const elapsedMs = performance.now() - start;
    expect(result).toBe('\n'.repeat(blockCount));
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test('every facts fence keeps world rows and removes private rows', () => {
    const body = `before\n${facts('WORLD_ONE', 'PRIVATE_ONE')}\nbetween\n${facts('WORLD_TWO', 'PRIVATE_TWO')}\nafter`;
    const result = sanitizeRemoteBody(body);
    for (const visible of ['before', 'between', 'after', 'WORLD_ONE', 'WORLD_TWO']) expect(result).toContain(visible);
    for (const hidden of ['PRIVATE_ONE', 'PRIVATE_TWO']) expect(result).not.toContain(hidden);
    expect(sanitizeRemoteBody(result)).toBe(result);
  });

  test('all takes fences disappear, including world-holder takes, alongside facts', () => {
    const take = `${TAKES_FENCE_BEGIN}\n| 1 | PRIVATE_TAKE | take | owner-example | 1 | | |\n${TAKES_FENCE_END}`;
    const worldTake = `${TAKES_FENCE_BEGIN}\n| 1 | WORLD_TAKE | fact | world | 1 | | |\n${TAKES_FENCE_END}`;
    const result = sanitizeRemoteBody(`before\n${take}\n${facts('WORLD_FACT', 'PRIVATE_FACT')}\n${worldTake}\nafter`);
    expect(result).toContain('WORLD_FACT');
    expect(result).toContain('before');
    expect(result).toContain('after');
    for (const hidden of ['PRIVATE_TAKE', 'WORLD_TAKE', 'PRIVATE_FACT', 'gbrain:takes']) expect(result).not.toContain(hidden);
  });

  for (const marker of [FACTS_FENCE_BEGIN, TAKES_FENCE_BEGIN]) {
    test(`unterminated ${marker} drops the protected tail`, () => {
      expect(sanitizeRemoteBody(`safe prefix\n${marker}\nPRIVATE_TAIL\notherwise ordinary suffix`)).toBe('safe prefix\n');
    });
  }

  for (const [outerStart, outerEnd] of [[FACTS_FENCE_BEGIN, FACTS_FENCE_END], [TAKES_FENCE_BEGIN, TAKES_FENCE_END]]) {
    for (const innerStart of [FACTS_FENCE_BEGIN, TAKES_FENCE_BEGIN]) {
      test(`nested ${innerStart} inside ${outerStart} drops the ambiguous tail`, () => {
        const body = `safe prefix\n${outerStart}\nPRIVATE_ONE\n${innerStart}\nPRIVATE_TWO\n${outerEnd}\nsuffix`;
        expect(sanitizeRemoteBody(body)).toBe('safe prefix\n');
      });
    }
  }

  test('an interleaved closing marker drops the ambiguous tail', () => {
    const body = `safe prefix\n${FACTS_FENCE_BEGIN}\nPRIVATE\n${TAKES_FENCE_END}\n${FACTS_FENCE_END}\nsuffix`;
    expect(sanitizeRemoteBody(body)).toBe('safe prefix\n');
  });

  test('a malformed facts block is omitted without echoing parser warnings', () => {
    const body = facts('WORLD_FACT', 'PRIVATE_FACT').replace('| private |', '| invalid-visibility |');
    const result = sanitizeRemoteBody(`before\n${body}\nafter`);
    expect(result).toBe('before\n\nafter');
    expect(result).not.toContain('PRIVATE_FACT');
    expect(result).not.toContain('invalid-visibility');
  });
});
