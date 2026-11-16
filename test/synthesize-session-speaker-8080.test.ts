/**
 * #8080 item 1: dream synthesis reads the speaker marker #8075 records for an
 * agent-launched session, so the worker's brief is never synthesized as what
 * the user said or requested. The facts pipeline's choice applies here too:
 * the session is kept and labeled as the agent's, not skipped.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTranscripts, readSingleTranscript } from '../src/core/cycle/transcript-discovery.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';

const corpus = mkdtempSync(join(tmpdir(), 'gbrain-synth-speaker-8080-'));
afterAll(() => rmSync(corpus, { recursive: true, force: true }));
const body = (topic: string) => `[user]\nPlease draft the release notes for ${topic}.\n\n${'[assistant]\nDrafting the notes now.\n\n'.repeat(10)}`;

describe('#8080 synthesis labels an agent-launched session', () => {
  const spool = ensureCorpusSpoolDir(corpus);
  const worker = join(spool, sessionCorpusFileName('sess-worker', 'default'));
  const owner = join(spool, sessionCorpusFileName('sess-owner', 'default'));
  writeFileSync(worker, body('the worker task'));
  writeFileSync(owner, body('the owner task'));
  writeSpeakerSidecar(spool, 'sess-worker', { principal: 'build-bot', source: 'env' }, 'claude-code');

  test('discovery carries the session speaker; an owner session has none', () => {
    const found = new Map(discoverTranscripts({ corpusDir: corpus, minChars: 10 }).map(t => [t.filePath, t]));
    expect(found.get(worker)?.speaker).toBe('build-bot');
    expect(found.get(owner)?.speaker).toBeUndefined();
    expect(readSingleTranscript(worker, { minChars: 10 })?.speaker).toBe('build-bot');
  });

  test("the synthesis prompt says the user turns are the agent's brief; an owner session's prompt is unchanged", () => {
    const found = new Map(discoverTranscripts({ corpusDir: corpus, minChars: 10 }).map(t => [t.filePath, t]));
    const prompt = (path: string) => __testing.buildSynthesisPrompt(found.get(path)!, found.get(path)!.content, 0, 1);
    expect(prompt(worker)).toContain('- Speaker: this session was launched by the automated agent "build-bot"');
    expect(prompt(worker)).toContain('attribute them to Agent build-bot');
    expect(prompt(owner)).not.toContain('Speaker:');
  });
});
