import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { SchemaPackManifestSchema, type SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { _resetPackCacheForTests, resolvePack } from '../src/core/schema-pack/registry.ts';
import { resolveExtractablePrompt } from '../src/core/schema-pack/prompt-template.ts';
import {
  prepareAtomSource,
  resolveAtomInputProfile,
} from '../src/core/schema-pack/source-input-profile.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const roots: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  _resetPackCacheForTests();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function manifest(
  name: string,
  version: string,
  extendsName: string | null,
  pageTypes: unknown[],
  linkTypes: unknown[] = [],
): SchemaPackManifest {
  return SchemaPackManifestSchema.parse({
    api_version: 'gbrain-schema-pack-v1',
    name,
    version,
    extends: extendsName,
    page_types: pageTypes,
    link_types: linkTypes,
  });
}

async function inheritedPack(
  promptPath = 'prompts/experience.md',
  prompt = 'Find bounded visible change.',
  childVersion = '1.0.0',
  inputProfile?: unknown,
  provenanceLinkType?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-pack-prompt-'));
  roots.push(root);
  const parentRoot = join(root, 'parent');
  const childRoot = join(root, 'child');
  mkdirSync(join(parentRoot, 'prompts'), { recursive: true });
  mkdirSync(join(parentRoot, 'input-profiles'), { recursive: true });
  mkdirSync(childRoot, { recursive: true });
  const parentPath = join(parentRoot, 'pack.json');
  const childPath = join(childRoot, 'pack.json');
  writeFileSync(parentPath, '{}');
  writeFileSync(childPath, '{}');
  writeFileSync(join(parentRoot, 'prompts', 'experience.md'), prompt);
  if (inputProfile) {
    writeFileSync(
      join(parentRoot, 'input-profiles', 'complete-source.json'),
      JSON.stringify(inputProfile),
    );
  }
  const parent = manifest('parent-pack', '1.0.0', null, [{
    name: 'experience', primitive: 'entity', path_prefixes: ['experiences/'], aliases: [],
    extractable: {
      prompt_template: promptPath,
      ...(inputProfile !== undefined
        ? { input_profile: 'input-profiles/complete-source.json' }
        : {}),
      eval_dimensions: ['source-closure'],
      ...(provenanceLinkType ? { provenance_link_type: provenanceLinkType } : {}),
    },
  }], provenanceLinkType ? [{ name: provenanceLinkType, inverse: 'source-supports-atom' }] : []);
  const child = manifest('child-pack', childVersion, 'parent-pack', []);
  const byName = new Map([[parent.name, parent], [child.name, child]]);
  const paths = new Map([[parent.name, parentPath], [child.name, childPath]]);
  const resolved = await resolvePack(child, async name => byName.get(name)!, {
    loadByPath: name => paths.get(name) ?? null,
  });
  return { root, parentRoot, resolved };
}

function completeSourceProfile(atomLimits?: { max_atoms_per_window: number; max_atoms_per_parent: number }) {
  return {
    schema_version: 'gbrain.extract_atoms.input_profile.v1',
    source: 'compiled_truth',
    selector: 'heading:Complete bounded source evidence',
    prior_interpretation: 'exclude',
    windowing: {
      mode: 'markdown_heading_and_turn_aware',
      max_chars: 1_000,
      overlap_chars: 100,
      coverage: 'complete',
    },
    reconciliation_grain: 'parent_page',
    evidence_anchor_validation: 'exact_source_anchor_required',
    ...(atomLimits ? { atom_limits: atomLimits } : {}),
  };
}

describe('pack-owned extract_atoms prompt', () => {
  test('resolves an inherited winning declaration inside the declaring pack', async () => {
    const { resolved } = await inheritedPack();
    expect(resolved.page_type_declaration_origins.experience.pack_name).toBe('parent-pack');
    const lens = resolveExtractablePrompt(resolved, 'experience');
    expect(lens?.prompt).toBe('Find bounded visible change.');
    expect(lens?.declaring_pack).toBe('parent-pack');
    expect(lens?.prompt_sha256).toHaveLength(64);
  });

  test('rejects absolute paths, traversal, symlinks, and missing files', async () => {
    for (const unsafe of ['/tmp/prompt.md', '../prompt.md', 'prompts/missing.md']) {
      const { resolved } = await inheritedPack(unsafe);
      expect(() => resolveExtractablePrompt(resolved, 'experience')).toThrow();
      _resetPackCacheForTests();
    }
    const fixture = await inheritedPack('prompts/link.md');
    symlinkSync(join(fixture.parentRoot, 'prompts', 'experience.md'), join(fixture.parentRoot, 'prompts', 'link.md'));
    expect(() => resolveExtractablePrompt(fixture.resolved, 'experience')).toThrow(/symlink/i);
  });

  test('resolves and completely windows a pack-declared source input profile', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md',
      'Find bounded visible change.',
      '1.0.0',
      completeSourceProfile(),
    );
    const input = resolveAtomInputProfile(resolved, 'experience');
    expect(input?.declaring_pack).toBe('parent-pack');
    expect(input?.profile_sha256).toHaveLength(64);
    const content =
      '## Prior interpretation\nSYNTHESIS_MUST_NOT_ENTER_EXTRACTION\n\n' +
      '## Complete bounded source evidence\n' +
      Array.from({ length: 8 }, (_, index) =>
        `<a id="evidence-turn-${index}"></a>\n#### Turn ${index}\n${String(index).repeat(420)}\n\n`,
      ).join('') +
      '<a id="evidence-tail"></a>\n#### Counterevidence\nUNIQUE_TAIL_COUNTEREXAMPLE';
    const prepared = prepareAtomSource(content, input!);
    expect(prepared.windows.length).toBeGreaterThan(1);
    expect(prepared.selected_source).not.toContain('SYNTHESIS_MUST_NOT_ENTER_EXTRACTION');
    expect(prepared.selected_source).toContain('UNIQUE_TAIL_COUNTEREXAMPLE');
    expect(prepared.evidence_anchors).toContain('evidence-tail');
    expect(prepared.windows.every(window => window.evidence_anchors.some(anchor => /^evidence-window-[a-f0-9]{16}$/u.test(anchor)))).toBe(true);
    expect(new Set(prepared.windows.flatMap(window => window.evidence_anchors.filter(anchor => anchor.startsWith('evidence-window-')))).size).toBe(prepared.windows.length);
    let covered = 0;
    for (const window of prepared.windows) {
      expect(window.start).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, window.end);
    }
    expect(covered).toBe(prepared.selected_source.length);
  });

  test('keeps source content in the user message and composes the lens with the fixed output contract', async () => {
    const { resolved } = await inheritedPack();
    const captured: { value?: ChatOpts } = {};
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      captured.value = opts;
      return {
        text: '[{"title":"Visible retry","atom_type":"insight","body":"The response changed."}]',
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    await runPhaseExtractAtoms(engine, {
        sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
        _pages: [{ slug: 'experiences/one', pageType: 'experience', content: 'UNTRUSTED_SOURCE_BODY', contentHash: '1234567890abcdef' }],
        _chat: chat,
      });
      expect(captured.value).toBeDefined();
      const call = captured.value!;
      expect(call.system).toContain('Find bounded visible change.');
      expect(call.system).toContain('Output ONLY the JSON array');
      expect(call.system).not.toContain('UNTRUSTED_SOURCE_BODY');
      expect(call.messages[0]?.content).toContain('UNTRUSTED_SOURCE_BODY');
      const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
        `SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL`,
      );
      expect(rows[0].frontmatter.extraction_profile_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0].frontmatter.extraction_declaring_pack).toBe('parent-pack');
    expect(rows[0].frontmatter.extraction_profile_state).toBe('active');
  }, 60_000);

  test('materializes the schema-pack provenance relationship type on native atom edges', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md',
      'Find bounded visible change.',
      '1.0.0',
      undefined,
      'derived-from-source',
    );
    await engine.putPage('experiences/typed', {
      type: 'experience' as never,
      title: 'Typed source',
      compiled_truth: 'A complete source body.',
      timeline: '',
    });
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/typed', pageType: 'experience', content: 'A complete source body.', contentHash: 'typed-source-hash' }],
      _chat: async (): Promise<ChatResult> => ({
        text: '[{"title":"Typed provenance","atom_type":"insight","body":"The evidence stays traceable."}]',
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      }),
    });
    const links = await engine.getLinks('experiences/typed');
    expect(links).toHaveLength(1);
    expect(links[0]?.link_type).toBe('derived-from-source');
    expect(links[0]?.link_source).toBe('atom-provenance');
  }, 60_000);

  test('a changed prompt profile re-extracts and supersedes only after the replacement is complete', async () => {
    const first = await inheritedPack('prompts/experience.md', 'Find the initial state.', '1.0.0');
    _resetPackCacheForTests();
    const second = await inheritedPack('prompts/experience.md', 'Find the later visible state.', '1.0.1');
    await engine.putPage('experiences/replay', {
      type: 'experience' as never, title: 'Replay', compiled_truth: 'e'.repeat(800),
      timeline: '', frontmatter: {}, content_hash: 'profile-source-hash-1234',
    });
    let title = 'Initial atom';
    const chat = async (_opts: ChatOpts): Promise<ChatResult> => ({
      text: `[{"title":"${title}","atom_type":"insight","body":"A bounded observation."}]`,
      blocks: [{ type: 'text', text: '' }], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    });
    const firstRun = await runPhaseExtractAtoms(engine, {
        _resolvedPack: first.resolved, _transcripts: [], _chat: chat,
      });
      expect(firstRun.details?.pages_processed).toBe(1);
      const replay = await runPhaseExtractAtoms(engine, {
        _resolvedPack: first.resolved, _transcripts: [], _chat: chat,
      });
      expect(replay.details?.pages_processed).toBe(0);
      title = 'Replacement atom';
      const replacement = await runPhaseExtractAtoms(engine, {
        _resolvedPack: second.resolved, _transcripts: [], _chat: chat,
      });
      expect(replacement.details?.pages_processed).toBe(1);
      const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null; state: string }>(
        `SELECT slug, deleted_at, frontmatter->>'extraction_profile_state' AS state
           FROM pages WHERE type='atom' ORDER BY slug`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.deleted_at === null).map(row => row.state)).toEqual(['active']);
    expect(rows.filter(row => row.deleted_at !== null).map(row => row.state)).toEqual(['superseded']);
  }, 60_000);

  test('processes every source window once, excludes synthesis, and reconciles tail evidence at parent grain', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md',
      'Find bounded visible change.',
      '1.1.0',
      completeSourceProfile(),
    );
    const source = Array.from({ length: 9 }, (_, index) =>
      `<a id="evidence-turn-${index}"></a>\n#### Turn ${index}\n${`turn-${index} `.repeat(75)}\n\n`,
    ).join('') + '<a id="evidence-tail"></a>\n#### Tail\nUNIQUE_TAIL_COUNTEREXAMPLE';
    const content =
      '## Prior interpretation\nSYNTHESIS_MUST_NOT_ENTER_EXTRACTION\n\n' +
      `## Complete bounded source evidence\n${source}`;
    const windowCalls: string[] = [];
    let reconciliationCalls = 0;
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      const body = String(opts.messages[0]?.content ?? '');
      let text: string;
      if (body.includes('Window candidates:')) {
        reconciliationCalls++;
        const tailCandidate = body.includes('evidence-tail')
          ? { title: 'Tail counterevidence', atom_type: 'critique', body: 'The tail changes the interpretation.', source_quote: 'UNIQUE_TAIL_COUNTEREXAMPLE', evidence_refs: ['evidence-tail'] }
          : { title: 'Visible response', atom_type: 'insight', body: 'A response was visible.', source_quote: '<a id="evidence-turn-0"></a>', evidence_refs: ['evidence-turn-0'] };
        text = JSON.stringify([tailCandidate]);
      } else {
        windowCalls.push(body);
        const anchors: string[] = body.match(/evidence-[a-z0-9-]+/gu) ?? [];
        const anchor = anchors.includes('evidence-tail') ? 'evidence-tail' : anchors[0];
        text = JSON.stringify(anchor ? [{
          title: anchor === 'evidence-tail' ? 'Tail counterevidence' : `Lead ${windowCalls.length}`,
          atom_type: anchor === 'evidence-tail' ? 'critique' : 'insight',
          body: anchor === 'evidence-tail' ? 'The tail changes the interpretation.' : 'A bounded response was visible.',
          source_quote: anchor === 'evidence-tail' ? 'UNIQUE_TAIL_COUNTEREXAMPLE' : `<a id="${anchor}"></a>`,
          evidence_refs: [anchor],
        }] : []);
      }
      return {
        text,
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/long', pageType: 'experience', content, contentHash: 'long-source-hash-1234' }],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(windowCalls.length).toBeGreaterThan(1);
    expect(reconciliationCalls).toBe(1);
    expect(windowCalls.every(call => !call.includes('SYNTHESIS_MUST_NOT_ENTER_EXTRACTION'))).toBe(true);
    expect(windowCalls.filter(call => call.includes('UNIQUE_TAIL_COUNTEREXAMPLE'))).toHaveLength(1);
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].frontmatter.evidence_refs).toEqual(['evidence-tail']);
    expect(rows[0].frontmatter.extraction_source_coverage).toBe('complete');
    expect(rows[0].frontmatter.extraction_source_window_count).toBe(windowCalls.length);
    expect(rows[0].frontmatter.extraction_profile_sha256).not.toBe(
      rows[0].frontmatter.extraction_policy_sha256,
    );
  }, 60_000);

  test('persists a private native attempt intent before the call and response usage after it', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md', 'Find bounded visible change.', '1.0.1', completeSourceProfile(),
    );
    const content = '## Complete bounded source evidence\n<a id="evidence-turn-0"></a>\nThe buyer committed to a dated follow-up.';
    const chat = async (): Promise<ChatResult> => {
      const intents = await engine.executeRaw<{ slug: string; status: string }>(
        `SELECT slug,frontmatter->>'attempt_status' status FROM pages WHERE type='extract_receipt' AND frontmatter->>'kind'='native-extract-attempt'`,
      );
      expect(intents).toHaveLength(1);
      expect(intents[0].status).toBe('intent_recorded');
      const raw = await engine.getRawData(intents[0].slug, undefined, { sourceId: 'default' });
      expect(raw.map(row => row.source)).toEqual(['native-extract-attempt-input']);
      return {
        text: JSON.stringify([{ title: 'Dated buyer commitment', atom_type: 'insight', body: 'The buyer owns a dated follow-up.', source_quote: 'The buyer committed to a dated follow-up.', evidence_refs: ['evidence-turn-0'] }]),
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 101, output_tokens: 29, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-5.6-luna', providerId: 'openai', providerMetadata: { response_id: 'fixture-response' },
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/audited', pageType: 'experience', content, contentHash: 'audited-source-hash' }],
      _chat: chat, _attemptAuditRunId: 'checkpoint-audit-v1',
    });
    expect(result.status).toBe('ok');
    const attempts = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown>; compiled_truth: string }>(
      `SELECT slug,frontmatter,compiled_truth FROM pages WHERE type='extract_receipt' AND frontmatter->>'kind'='native-extract-attempt'`,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].frontmatter.attempt_status).toBe('response_recorded');
    expect(attempts[0].frontmatter.input_tokens).toBe(101);
    expect(attempts[0].frontmatter.output_tokens).toBe(29);
    expect(attempts[0].compiled_truth).not.toContain('The buyer committed');
    const raw = await engine.getRawData(attempts[0].slug, undefined, { sourceId: 'default' });
    expect(raw.map(row => row.source).sort()).toEqual(['native-extract-attempt-input', 'native-extract-attempt-response']);
  }, 60_000);

  test('honors pack-owned window and parent atom limits without collapsing a long source to three atoms', async () => {
    const atomLimits = { max_atoms_per_window: 2, max_atoms_per_parent: 6 };
    const { resolved } = await inheritedPack(
      'prompts/experience.md',
      'Extract every decision-useful event ingredient.',
      '1.1.1',
      completeSourceProfile(atomLimits),
    );
    const source = Array.from({ length: 9 }, (_, index) =>
      `<a id="evidence-turn-${index}"></a>\n#### Turn ${index}\n${`ingredient-${index} `.repeat(75)}\n\n`,
    ).join('');
    const content = `## Complete bounded source evidence\n${source}`;
    let windowIndex = 0;
    let reconciliationSystem = '';
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      const body = String(opts.messages[0]?.content ?? '');
      let atoms: Array<Record<string, unknown>>;
      if (body.includes('Window candidates:')) {
        reconciliationSystem = opts.system ?? '';
        atoms = Array.from({ length: 6 }, (_, index) => ({
          title: `Parent ingredient ${index}`,
          atom_type: 'insight',
          body: `Ingredient ${index} remains independently useful.`,
          source_quote: `<a id="evidence-turn-${index}"></a>`,
          evidence_refs: [`evidence-turn-${index}`],
        }));
      } else {
        const anchors = [...new Set(body.match(/evidence-turn-\d+/gu) ?? [])];
        atoms = anchors.slice(0, atomLimits.max_atoms_per_window).map((anchor, index) => ({
          title: `Window ${windowIndex} ingredient ${index}`,
          atom_type: 'insight',
          body: 'A bounded event ingredient is visible.',
          source_quote: `<a id="${anchor}"></a>`,
          evidence_refs: [anchor],
        }));
        windowIndex++;
      }
      return {
        text: JSON.stringify(atoms),
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/maximal', pageType: 'experience', content, contentHash: 'maximal-source-hash' }],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(reconciliationSystem).toContain('Return at most 6 atoms');
    expect(reconciliationSystem).not.toContain('1-3 per transcript, never more than 3');
    expect(reconciliationSystem).toContain('Do not rank or collapse the candidates to a top three');
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every(row => row.frontmatter.extraction_max_atoms_per_window === 2)).toBe(true);
    expect(rows.every(row => row.frontmatter.extraction_max_atoms_per_parent === 6)).toBe(true);
  }, 60_000);

  test('rejects a source-complete atom whose source_quote is not one exact contiguous span', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md',
      'Find bounded visible change.',
      '1.2.0',
      completeSourceProfile(),
    );
    const content =
      '## Complete bounded source evidence\n' +
      '<a id="evidence-turn-0"></a>\nThe buyer will invite procurement next Thursday.';
    const chat = async (): Promise<ChatResult> => ({
      text: JSON.stringify([{
        title: 'Procurement commitment', atom_type: 'insight', body: 'The buyer made a dated commitment.',
        source_quote: 'The buyer agreed to invite procurement next Thursday.',
        evidence_refs: ['evidence-turn-0'],
      }]),
      blocks: [{ type: 'text', text: '' }], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
    });
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/quote-drift', pageType: 'experience', content, contentHash: 'quote-drift-source-hash' }],
      _chat: chat,
    });
    expect(result.status).toBe('warn');
    expect(result.details?.malformed_outputs).toBe(1);
    expect(String((result.details?.failures as Array<{ error: string }>)[0]?.error)).toContain('source_quote');
    const atoms = await engine.executeRaw(`SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL`);
    expect(atoms).toHaveLength(0);
  }, 60_000);

  test('makes one bounded native grounding retry and admits only the exact replacement', async () => {
    const { resolved } = await inheritedPack(
      'prompts/experience.md', 'Find bounded visible change.', '1.3.0', completeSourceProfile(),
    );
    const content =
      '## Complete bounded source evidence\n' +
      '<a id="evidence-turn-0"></a>\nThe buyer will invite procurement next Thursday.';
    let calls = 0;
    const chat = async (): Promise<ChatResult> => {
      calls++;
      return {
        text: JSON.stringify([{
          title: 'Procurement commitment', atom_type: 'insight', body: 'The buyer made a dated commitment.',
          source_quote: calls === 1
            ? 'The buyer agreed to invite procurement next Thursday.'
            : 'The buyer will invite procurement next Thursday.',
          evidence_refs: ['evidence-turn-0'],
        }]),
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: [{ slug: 'experiences/quote-repair', pageType: 'experience', content, contentHash: 'quote-repair-source-hash' }],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.grounding_retries).toBe(1);
    expect(calls).toBe(2);
    const atoms = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL`,
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0].frontmatter.source_quote).toBe('The buyer will invite procurement next Thursday.');
    expect(atoms[0].frontmatter.extraction_source_quote_span_unit).toBe('utf16_code_units_v1');
    expect(atoms[0].frontmatter.extraction_source_quote_start).toBe(content.indexOf('The buyer will invite'));
    expect(atoms[0].frontmatter.extraction_source_quote_end).toBe(content.length);
    expect(atoms[0].frontmatter.extraction_source_quote_sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);

  test('runs source items with an explicit bounded concurrency while preserving exact writes', async () => {
    const { resolved } = await inheritedPack();
    await engine.setConfig('cycle.extract_atoms.concurrency', '4');
    let inFlight = 0;
    let maximumInFlight = 0;
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      const content = String(opts.messages[0]?.content ?? '');
      const id = content.match(/SOURCE-(\d+)/u)?.[1] ?? 'unknown';
      inFlight--;
      return {
        text: JSON.stringify([{
          title: `Concurrent atom ${id}`,
          atom_type: 'insight',
          body: `Source ${id} completed through bounded concurrency.`,
        }]),
        blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _resolvedPack: resolved, _transcripts: [],
      _pages: Array.from({ length: 8 }, (_, index) => ({
        slug: `experiences/concurrent-${index}`,
        pageType: 'experience',
        content: `SOURCE-${index} ${'e'.repeat(600)}`,
        contentHash: `concurrent-source-hash-${index}`,
      })),
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(maximumInFlight).toBe(4);
    expect(result.details?.extraction_concurrency).toBe(4);
    expect(result.details?.pages_processed).toBe(8);
    const rows = await engine.executeRaw(`SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL`);
    expect(rows).toHaveLength(8);
  }, 60_000);
});
