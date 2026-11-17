/**
 * GBRA-585: the folder-rule preview asks for --yes --expect <revision>, so the command it prints carries both.
 *
 * 1. Protects: the human preview of gbrain access rule add prints a rerun command that ends in --yes --expect <n>,
 *    with the revision the preview asked for, and running that exact command applies the rule.
 * 2. Fails when: the printed command drops --expect (the walk's "To approve, add --yes --expect 0 (gbrain access rule
 *    add … --yes)"), or names another revision.
 * 3. Real seams: the gbrain access rule CLI module on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
});
afterAll(async () => { await engine.disconnect(); });

async function printed(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, args.slice(1), false); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

describe('access rule preview (GBRA-585)', () => {
  test('the printed approve command carries the --expect the preview asks for, and running it applies', async () => {
    const preview = await printed(['rule', 'add', '--prefix', 'team/', '--readers', 'alice-example,bob-example']);
    const line = preview.split('\n').find(l => l.startsWith('Nothing written. To approve'))!;
    const expectN = /add --yes --expect (\d+)/.exec(line)?.[1];
    expect(expectN).toBe('0');
    const command = /\((gbrain access rule .*)\)\.$/.exec(line)?.[1];
    expect(command).toBe(`gbrain access rule add --prefix team/ --readers alice-example,bob-example --yes --expect ${expectN}`);
    const applied = await printed(command!.split(' ').slice(2));
    expect(applied).toContain('applied');
  });
});
