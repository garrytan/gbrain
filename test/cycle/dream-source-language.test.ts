/**
 * #25 — dream pages follow the Исходный язык (CONTEXT.md, ADR-0002).
 *
 * A Russian transcript used to produce English reflections, originals,
 * patterns and concept pages: SYNTH_PROMPT asked for "plain English",
 * EXTRACT_PROMPT for "English TOPIC labels", and the slug rules said
 * "alphanumeric", which models read as ASCII. Concept labels were also
 * filtered through an ASCII-only check, so a Cyrillic label vanished.
 *
 * Pins, per prompt that writes page text: the language rule is present, no
 * English-only instruction survives, and the slug wording is script-neutral.
 * Asserted on the prompt actually built or sent through the chat seam.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { parseAtomsResponse } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { __testing as synthesizeTesting } from '../../src/core/cycle/synthesize.ts';
import { __testing as patternsTesting } from '../../src/core/cycle/patterns.ts';
import { __testing as allowlistTesting } from '../../src/core/minions/tools/brain-allowlist.ts';
import { operations } from '../../src/core/operations.ts';
import { ONESHOT_SYSTEM } from '../../src/core/minions/handlers/subagent-oneshot.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from '../helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

const LANGUAGE_RULE = /in the language most of [\s\S]*? is written in/;
const KEEP_TERMS_RULE = /names, product names, commands and technical terms exactly as/;
const SCRIPT_NEUTRAL_SLUG = /lowercase letters of any script, digits and hyphens/;
const SLUG_FOLLOWS_TITLE = /topic words of a slug are written in the language of the page title/;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  } as ChatResult;
}

describe('#25 synthesize prompt (reflections, originals)', () => {
  const transcript = {
    filePath: '/tmp/2026-09-27-созвон.txt',
    basename: '2026-09-27-созвон',
    content: 'x',
    contentHash: 'a'.repeat(64),
    inferredDate: '2026-09-27',
  };

  test('asks for pages in the language of the transcript, with script-neutral slugs', () => {
    const prompt = synthesizeTesting.buildSynthesisPrompt(transcript as never, 'Разговор о планах.', 0, 1);
    expect(prompt).toMatch(LANGUAGE_RULE);
    expect(prompt).toMatch(KEEP_TERMS_RULE);
    expect(prompt).toMatch(SCRIPT_NEUTRAL_SLUG);
    expect(prompt).toMatch(SLUG_FOLLOWS_TITLE);
    expect(prompt).not.toMatch(/alphanumeric/);
  });

  test('the oneshot system contract asks for slugs in the language of the page title', () => {
    // oneshot is the default synthesize mode; with no language rule here a
    // Russian page came back with an English slug in the manual dream run.
    expect(ONESHOT_SYSTEM).toMatch(SLUG_FOLLOWS_TITLE);
    expect(ONESHOT_SYSTEM).toMatch(SCRIPT_NEUTRAL_SLUG);
  });

  test('the rule is language-neutral, so an English transcript is not steered to Russian', () => {
    const prompt = synthesizeTesting.buildSynthesisPrompt(
      { ...transcript, basename: '2026-09-27-call', filePath: '/tmp/2026-09-27-call.txt' } as never,
      'A call about plans.', 0, 1,
    );
    expect(prompt).toMatch(LANGUAGE_RULE);
    expect(prompt).not.toMatch(/Russian|Cyrillic/);
  });

  test('the agentic put_page schema a dream child sees uses the script-neutral slug wording', () => {
    const putPage = operations.find((op) => op.name === 'put_page')!;
    const schema = allowlistTesting.namespacedPutPageSchema(putPage, 1, ['wiki/personal/reflections/*']) as {
      properties: { slug: { description: string } };
    };
    expect(schema.properties.slug.description).toMatch(SCRIPT_NEUTRAL_SLUG);
    expect(schema.properties.slug.description).not.toMatch(/alphanumeric/);
  });
});

describe('#25 patterns prompt', () => {
  test('asks for pattern pages in the language of the reflections, with script-neutral slugs', () => {
    const prompt = patternsTesting.buildPatternsPrompt(
      [{ slug: 'wiki/personal/reflections/2026-09-27-тема', title: 'Тема', excerpt: 'Текст.' }] as never,
      2,
    );
    expect(prompt).toMatch(SLUG_FOLLOWS_TITLE);
    expect(prompt).toMatch(LANGUAGE_RULE);
    expect(prompt).toMatch(KEEP_TERMS_RULE);
    expect(prompt).toMatch(SCRIPT_NEUTRAL_SLUG);
    expect(prompt).not.toMatch(/alphanumeric/);
  });
});

describe('#25 extract_atoms prompt and concept labels', () => {
  test('the system prompt sent to the model asks for atoms and concept labels in the transcript language', async () => {
    let capturedSystem = '';
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'documents/redis-queues', content: 'В Redis очередь делается на LIST. '.repeat(20), contentHash: 'c'.repeat(16) }],
      _chat: async (opts: ChatOpts) => {
        capturedSystem = String(opts.system ?? '');
        return okChatResult('[]');
      },
    });
    expect(capturedSystem.length).toBeGreaterThan(0); // the seam was hit
    expect(capturedSystem).toMatch(LANGUAGE_RULE);
    expect(capturedSystem).toMatch(KEEP_TERMS_RULE);
    expect(capturedSystem).toMatch(SCRIPT_NEUTRAL_SLUG);
    expect(capturedSystem).not.toMatch(/English TOPIC/);
    // A technical topic keeps a descriptive label in the transcript language.
    expect(capturedSystem).toMatch(/even when\s+the text uses an English term/);
  });

  test('concept labels of any script survive parsing; labels the slug grammar would rewrite do not', () => {
    const raw = JSON.stringify([{
      title: 'Очередь на LIST теряет сообщения',
      atom_type: 'insight',
      body: 'Тело.',
      concepts: ['очереди-сообщений', 'ёмкость-очереди', 'captive-portal'],
    }, {
      title: 'Второй',
      atom_type: 'insight',
      body: 'Тело.',
      concepts: ['Очереди_Сообщений', 'Captive Portal', 'café', '-очереди'],
    }]);
    const atoms = parseAtomsResponse(raw);
    expect(atoms[0].concepts).toEqual(['очереди-сообщений', 'ёмкость-очереди', 'captive-portal']);
    expect(atoms[1].concepts).toBeUndefined();
  });
});

describe('#25 synthesize_concepts', () => {
  test('the summary prompt follows the atoms language and a Cyrillic label mints a Cyrillic concept page', async () => {
    const atoms = Array.from({ length: 5 }, (_, i) => ({
      slug: `atoms/2026-09-27/atom-${i}`,
      title: `Атом ${i}`,
      body: `Очередь на LIST теряет сообщение ${i}.`,
      concept_refs: ['очереди-сообщений'],
    }));
    let capturedSystem = '';
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: (async (opts: ChatOpts) => {
        capturedSystem = String(opts.system ?? '');
        return okChatResult('Очереди на LIST теряют сообщения при падении обработчика.');
      }) as typeof import('../../src/core/ai/gateway.ts').chat,
    });
    // status is 'warn' here only because the fixture atoms are not pages, so
    // provenance links have nothing to land on (same for an ASCII label).
    expect(result.details?.concepts_written).toBe(1);
    expect(capturedSystem).toMatch(LANGUAGE_RULE);
    expect(capturedSystem).not.toMatch(/plain English/);
    const page = await engine.getPage('concepts/очереди-сообщений', { sourceId: 'default' });
    expect(page?.title).toBe('очереди сообщений');
    expect(page?.compiled_truth).toContain('Очереди на LIST теряют сообщения');
  });
});
