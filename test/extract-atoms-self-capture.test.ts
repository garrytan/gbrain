/**
 * #5820: dream extract_atoms discovers session-corpus transcripts, so a corpus
 * file captured from gbrain's own claude-cli call must be skipped there exactly
 * as synthesize skips it (`selfCaptureSessionIds`), or each one costs another
 * extraction call.
 *
 * Pins, through real discovery (configured corpus dir) and the chat seam: the
 * self-capture never reaches the model; an ordinary session in the same
 * corpus still does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../src/core/ai/providers/claude-cli-scratch.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let root: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => { await resetPgliteState(engine); });

function reply(): ChatResult {
  const text = '{"atoms":[]}';
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' } as ChatResult;
}

describe('extract_atoms skips gbrain claude-cli self-captures (#5820)', () => {
  test('a self-capture corpus file never reaches the model; an ordinary session does', async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-atoms-self-'));
    const corpusDir = join(root, 'corpus');
    const claudeDir = join(root, 'claude');
    const scratch = join(claudeDir, 'projects', `-tmp-${CLAUDE_CLI_CWD_PREFIX}4242`);
    mkdirSync(corpusDir, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(root, 'brain'), { recursive: true });
    writeFileSync(join(scratch, 'sess-self.jsonl'), '{}\n');
    writeFileSync(join(corpusDir, 'sess-self.txt'), `[user]\nExtract the facts from the following page and return JSON.\n\n[assistant]\n${'{"facts":[]} '.repeat(200)}\n`);
    writeFileSync(join(corpusDir, 'sess-human.txt'), `[user]\nI decided we ship the reversible pricing change first.\n\n[assistant]\n${'Noted, measuring for two weeks. '.repeat(80)}\n`);

    const sources: string[] = [];
    await withEnv({ CLAUDE_CONFIG_DIR: claudeDir }, async () => {
      await runPhaseExtractAtoms(engine, {
        sourceId: 'default', brainDir: join(root, 'brain'), _pages: [],
        _loadConfig: () => ({ dream: { synthesize: { session_corpus_dir: corpusDir } } }) as unknown as GBrainConfig,
        _chat: async (opts: ChatOpts) => {
          sources.push(/^Source: (.*)$/m.exec(String(opts.messages[0]?.content ?? ''))?.[1] ?? '');
          return reply();
        },
      });
    });
    expect(sources).toEqual([join(corpusDir, 'sess-human.txt')]);
  });
});
