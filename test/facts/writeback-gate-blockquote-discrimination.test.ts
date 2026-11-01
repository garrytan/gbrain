import { describe, expect, test } from 'bun:test';
import { gateWritebackTurn, turnHash24 } from '../../src/core/facts/writeback-gate.ts';

describe('writeback gate blockquote banking', () => {
  test('accepted turns bank and hash only unquoted lines', () => {
    const quoted = [
      '> The deploy moves to Fridays.',
      '> Staging uses Postgres 14.',
    ].join('\n');
    const fenced = '````\n> Example code output\n```\n> A literal blockquote marker in code\n````';
    const tildeFenced = '~~~~text\n> Tilde-fenced content\n~~~\n> Still inside the tilde fence\n~~~~';
    const indented = [
      '    build output one',
      '    build output two',
      '    build output three',
    ].join('\n');
    const own = 'No, we deploy on Tuesdays and staging uses Postgres 17.';
    let result: ReturnType<typeof gateWritebackTurn> | undefined;
    let threw = false;

    try {
      result = gateWritebackTurn(`${quoted}\n\n${own}\n\n${fenced}\n\n${tildeFenced}\n\n${indented}`);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    const normalized = result?.ok ? result.normalized : undefined;
    const hash24 = result?.ok ? result.hash24 : undefined;
    const banked = 'No, we deploy on Tuesdays and staging uses Postgres 17. ```` > Example code output ``` > A literal blockquote marker in code ```` ~~~~text > Tilde-fenced content ~~~ > Still inside the tilde fence ~~~~ build output one build output two build output three';
    expect(normalized).toBe(banked);
    expect(hash24).toBe(turnHash24(banked));
  });
});
