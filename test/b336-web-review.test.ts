import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { reviewCommand, reviewConnectorBatch } from '../src/core/connectors/review.ts';

for (const provider of ['chatgpt', 'claude'] as const) {
  test(`${provider}: native parser and redaction precede the host review`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'b336-review-'));
    try {
      const file = join(root, 'fixture.json');
      const secret = 'sk-ant-' + 'A'.repeat(60);
      const message = 'api_key=' + secret + ' Keep the actual fixture ending ' + 'x'.repeat(40000) + ' END';
      const conv = provider === 'claude' ? { uuid: 'fixture', name: 'fixture', chat_messages: [{ sender: 'human', text: message }] }
        : { id: 'fixture', title: 'fixture', current_node: 'n', mapping: { n: { id: 'n', parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: [message] } } } } };
      writeFileSync(file, JSON.stringify([conv]));
      const rows = await reviewConnectorBatch(file, provider, 'default', ['/fixture'], ((_exe: any, _args: any, opts: any) => {
        const payload = JSON.parse(opts.input);
        expect(payload.messages[0].text.endsWith(' END')).toBe(true);
        expect(payload.messages[0].text).not.toContain(secret);
        return { status: 0, stdout: JSON.stringify({ schema: 'gbrain-connector-review-output/v1',
          input_sha256: createHash('sha256').update(opts.input).digest('hex'), verdict: 'keep' }) };
      }) as any);
      expect(rows.get('fixture')).toBe('keep');
      const failed = await reviewConnectorBatch(file, provider, 'default', ['/fixture'], (() => ({status: 1, stdout: 'untrusted'})) as any);
      expect(failed.get('fixture')).toBe('unsure');
      const forged = await reviewConnectorBatch(file, provider, 'default', ['/fixture'], (() => ({status: 0, stdout: JSON.stringify({schema: 'gbrain-connector-review-output/v1', input_sha256: 'wrong', verdict: 'keep'})})) as any);
      expect(forged.get('fixture')).toBe('unsure');
    } finally {
      const trash = join(homedir(), '.Trash'); mkdirSync(trash, {recursive: true}); renameSync(root, join(trash, root.split('/').pop()!));
    }
  });
}
test('host command is an explicit absolute argv, never a shell string', () => {
  expect(reviewCommand('["/bin/reviewer","arg with spaces"]')).toEqual(['/bin/reviewer', 'arg with spaces']);
  for (const bad of ['echo hi', '[]', '["relative"]', '["/bin/a", 1]']) expect(() => reviewCommand(bad)).toThrow();
});
