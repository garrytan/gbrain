/**
 * BrainWriter + Scaffolder + SlugRegistry + 4 validators.
 *
 * Runs against PGLite in-memory. No network. Engine lifecycle per-suite
 * via beforeAll/afterAll so migrations apply once.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ResolverContext } from '../src/core/resolvers/index.ts';

import {
  BrainWriter,
  WriteError,
  type ValidationReport,
} from '../src/core/output/writer.ts';
import { SlugRegistry, SlugRegistryError } from '../src/core/output/slug-registry.ts';
import {
  tweetCitation,
  emailCitation,
  sourceCitation,
  entityLink,
  timelineLine,
  ScaffoldError,
} from '../src/core/output/scaffold.ts';
import {
  citationValidator,
  linkValidator,
  backLinkValidator,
  tripleHrValidator,
  registerBuiltinValidators,
} from '../src/core/output/validators/index.ts';
import {
  splitParagraphs,
} from '../src/core/output/validators/citation.ts';
import {
  normalizeToSlug,
  isExternalUrl,
  isNonBrainRef,
} from '../src/core/output/validators/link.ts';

// ---------------------------------------------------------------------------
// Engine fixture
// ---------------------------------------------------------------------------

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'writer-test-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbDir });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

// Reset DB between tests by truncating — cheaper than tearing down PGLite.
async function reset(): Promise<void> {
  await engine.executeRaw('TRUNCATE pages, links, content_chunks, timeline_entries, tags, raw_data, page_versions RESTART IDENTITY CASCADE');
}

function makeCtx(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return {
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    requestId: 'test',
    remote: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scaffolder
// ---------------------------------------------------------------------------

describe('Scaffolder', () => {
  test('tweetCitation builds canonical form', () => {
    const c = tweetCitation({ handle: 'garrytan', tweetId: '1234567890', dateISO: '2026-04-18' });
    expect(c).toBe('[Source: [X/garrytan, 2026-04-18](https://x.com/garrytan/status/1234567890)]');
  });

  test('tweetCitation strips leading @', () => {
    const c = tweetCitation({ handle: '@garrytan', tweetId: '1', dateISO: '2026-04-18' });
    expect(c).toContain('X/garrytan');
    expect(c).not.toContain('@garrytan');
  });

  test('tweetCitation rejects invalid handle', () => {
    expect(() => tweetCitation({ handle: 'not a handle', tweetId: '1' })).toThrow(ScaffoldError);
  });

  test('tweetCitation rejects non-numeric tweet id', () => {
    expect(() => tweetCitation({ handle: 'garrytan', tweetId: 'abc' })).toThrow(ScaffoldError);
  });

  test('tweetCitation rejects bad date format', () => {
    expect(() => tweetCitation({ handle: 'garrytan', tweetId: '1', dateISO: '2026/04/18' })).toThrow(ScaffoldError);
  });

  test('emailCitation builds deep link and encodes account', () => {
    const c = emailCitation({
      account: 'garry@ycombinator.com',
      messageId: 'abc123def456',
      subject: 'Re: Deal',
      dateISO: '2026-04-18',
    });
    expect(c).toContain('garry%40ycombinator.com');
    expect(c).toContain('#inbox/abc123def456');
    expect(c).toContain('"Re: Deal"');
  });

  test('emailCitation rejects short message id', () => {
    expect(() => emailCitation({
      account: 'x',
      messageId: 'short',
      subject: 'x',
    })).toThrow(ScaffoldError);
  });

  test('sourceCitation with url', () => {
    const r = sourceCitation({ source: 'perplexity-sonar', fetchedAt: new Date('2026-04-18') }, { url: 'https://example.com/r' });
    expect(r).toBe('[Source: [perplexity-sonar, 2026-04-18](https://example.com/r)]');
  });

  test('sourceCitation without url', () => {
    const r = sourceCitation({ source: 'perplexity-sonar', fetchedAt: new Date('2026-04-18') });
    expect(r).toBe('[Source: perplexity-sonar, 2026-04-18]');
  });

  test('entityLink prefix + slug', () => {
    const l = entityLink({ slug: 'people/alice-smith', displayText: 'Alice', relativePrefix: '../../' });
    expect(l).toBe('[Alice](../../people/alice-smith.md)');
  });

  test('entityLink sanitizes display text', () => {
    // Newlines → spaces, brackets stripped, trimmed
    const l = entityLink({ slug: 'people/alice', displayText: 'A\nli[ce]' });
    expect(l).toBe('[A lice](people/alice.md)');
  });

  test('entityLink rejects invalid slug', () => {
    expect(() => entityLink({ slug: 'invalid', displayText: 'x' })).toThrow(ScaffoldError);
    expect(() => entityLink({ slug: 'Bad/Slug', displayText: 'x' })).toThrow(ScaffoldError);
  });

  test('timelineLine builds canonical form', () => {
    const l = timelineLine({ dateISO: '2026-04-18', summary: 'Met Alice', citation: '[Source: x, y]' });
    expect(l).toBe('- **2026-04-18** | Met Alice [Source: x, y]');
  });
});

// ---------------------------------------------------------------------------
// SlugRegistry
// ---------------------------------------------------------------------------

describe('SlugRegistry', () => {
  beforeEach(async () => { await reset(); });

  test('create on empty brain returns desired slug', async () => {
    const reg = new SlugRegistry(engine);
    const r = await reg.create({
      desiredSlug: 'people/alice-smith',
      displayName: 'Alice Smith',
      type: 'person',
    });
    expect(r.slug).toBe('people/alice-smith');
    expect(r.exact).toBe(true);
    expect(r.disambiguator).toBeUndefined();
  });

  test('create disambiguates on collision', async () => {
    const reg = new SlugRegistry(engine);
    await engine.putPage('people/alice-smith', {
      type: 'person', title: 'Alice Smith', compiled_truth: 'x', frontmatter: {},
    });
    const r = await reg.create({
      desiredSlug: 'people/alice-smith',
      displayName: 'Different Alice',
      type: 'person',
    });
    expect(r.slug).toBe('people/alice-smith-2');
    expect(r.exact).toBe(false);
    expect(r.disambiguator).toBe(2);
  });

  test('create throws on collision when onCollision=throw', async () => {
    const reg = new SlugRegistry(engine);
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: 'x', frontmatter: {} });
    await expect(reg.create({
      desiredSlug: 'people/bob',
      displayName: 'Bob',
      type: 'person',
      onCollision: 'throw',
    })).rejects.toThrow(SlugRegistryError);
  });

  test('create throws on invalid slug', async () => {
    const reg = new SlugRegistry(engine);
    await expect(reg.create({
      desiredSlug: 'bad slug with spaces',
      displayName: 'x',
      type: 'person',
    })).rejects.toThrow(SlugRegistryError);
  });

  test('isFree + suggestDisambiguators', async () => {
    const reg = new SlugRegistry(engine);
    await engine.putPage('people/charlie', { type: 'person', title: 'Charlie', compiled_truth: 'x', frontmatter: {} });
    expect(await reg.isFree('people/charlie')).toBe(false);
    expect(await reg.isFree('people/dave')).toBe(true);
    const suggestions = await reg.suggestDisambiguators('people/charlie', 3);
    expect(suggestions).toEqual(['people/charlie-2', 'people/charlie-3', 'people/charlie-4']);
  });
});

// ---------------------------------------------------------------------------
// BrainWriter
// ---------------------------------------------------------------------------

describe('BrainWriter', () => {
  beforeEach(async () => { await reset(); });

  test('transaction creates entity, returns slug + empty report', async () => {
    const writer = new BrainWriter(engine);
    const { result, report } = await writer.transaction(async (tx) => {
      return tx.createEntity({
        desiredSlug: 'people/alice',
        displayName: 'Alice',
        type: 'person',
        compiledTruth: 'Alice is a person.',
      });
    }, makeCtx());
    expect(result).toBe('people/alice');
    expect(report.errorCount).toBe(0);
    expect(report.touchedSlugs).toEqual(['people/alice']);
  });

  test('transaction disambiguates slug collision', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/eve',
      displayName: 'Eve',
      type: 'person',
      compiledTruth: 'first eve',
    }), makeCtx());
    const { result } = await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/eve',
      displayName: 'Eve (different)',
      type: 'person',
      compiledTruth: 'second eve',
    }), makeCtx());
    expect(result).toBe('people/eve-2');
  });

  test('addLink creates forward + back-link', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => {
      await tx.createEntity({ desiredSlug: 'people/a', displayName: 'A', type: 'person', compiledTruth: 'a' });
      await tx.createEntity({ desiredSlug: 'people/b', displayName: 'B', type: 'person', compiledTruth: 'b' });
      await tx.addLink('people/a', 'people/b', 'connected', 'knows');
    }, makeCtx());

    const outbound = await engine.getLinks('people/a');
    const inbound = await engine.getBacklinks('people/a');
    expect(outbound.map(l => l.to_slug)).toContain('people/b');
    expect(inbound.map(l => l.from_slug)).toContain('people/b');
  });

  test('strict mode rolls back on validator error', async () => {
    const writer = new BrainWriter(engine, { strictMode: 'strict' });
    writer.register({
      id: 'synthetic-fail',
      async validate({ slug }) {
        return [{ slug, validator: 'synthetic-fail', severity: 'error', message: 'boom' }];
      },
    });
    await expect(writer.transaction(async (tx) => {
      await tx.createEntity({
        desiredSlug: 'people/ghost',
        displayName: 'Ghost',
        type: 'person',
        compiledTruth: 'x',
      });
    }, makeCtx())).rejects.toThrow(WriteError);

    // Page should not exist after rollback
    const page = await engine.getPage('people/ghost');
    expect(page).toBeNull();
  });

  test('lint mode does NOT roll back on validator error', async () => {
    const writer = new BrainWriter(engine, { strictMode: 'lint' });
    writer.register({
      id: 'synthetic-fail',
      async validate({ slug }) {
        return [{ slug, validator: 'synthetic-fail', severity: 'error', message: 'still writes in lint' }];
      },
    });
    const { result, report } = await writer.transaction(async (tx) => {
      return tx.createEntity({
        desiredSlug: 'people/lint-test',
        displayName: 'Lint',
        type: 'person',
        compiledTruth: 'x',
      });
    }, makeCtx());
    expect(result).toBe('people/lint-test');
    expect(report.errorCount).toBe(1);
    const page = await engine.getPage('people/lint-test');
    expect(page).not.toBeNull();
  });

  test('off mode skips validators entirely', async () => {
    const writer = new BrainWriter(engine, { strictMode: 'off' });
    let called = 0;
    writer.register({
      id: 'should-not-run',
      async validate() { called++; return []; },
    });
    await writer.transaction(async (tx) => {
      await tx.createEntity({ desiredSlug: 'people/no-validator', displayName: 'x', type: 'person', compiledTruth: 'x' });
    }, makeCtx());
    expect(called).toBe(0);
  });

  test('validators skip pages with validate:false frontmatter', async () => {
    const writer = new BrainWriter(engine, { strictMode: 'strict' });
    let called = 0;
    writer.register({
      id: 'count',
      async validate() { called++; return []; },
    });
    await writer.transaction(async (tx) => {
      await tx.createEntity({
        desiredSlug: 'people/grandfathered',
        displayName: 'Old',
        type: 'person',
        compiledTruth: 'legacy content without citations',
        frontmatter: { validate: false },
      });
    }, makeCtx());
    expect(called).toBe(0);
  });

  test('setCompiledTruth updates existing page', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/update',
      displayName: 'Update',
      type: 'person',
      compiledTruth: 'original',
    }), makeCtx());
    await writer.transaction(async (tx) => tx.setCompiledTruth('people/update', 'updated'), makeCtx());
    const page = await engine.getPage('people/update');
    expect(page?.compiled_truth).toBe('updated');
  });

  test('setFrontmatterField merges into existing frontmatter', async () => {
    const writer = new BrainWriter(engine);
    await writer.transaction(async (tx) => tx.createEntity({
      desiredSlug: 'people/fm',
      displayName: 'FM',
      type: 'person',
      compiledTruth: 'x',
      frontmatter: { role: 'founder' },
    }), makeCtx());
    await writer.transaction(async (tx) => tx.setFrontmatterField('people/fm', 'validate', false), makeCtx());
    const page = await engine.getPage('people/fm');
    expect(page?.frontmatter?.role).toBe('founder');
    expect(page?.frontmatter?.validate).toBe(false);
  });

  test('registeredValidators lists ids', () => {
    const writer = new BrainWriter(engine);
    registerBuiltinValidators(writer);
    expect(writer.registeredValidators).toEqual(['citation', 'link', 'back-link', 'triple-hr']);
  });
});

// ---------------------------------------------------------------------------
// Citation validator (pure, no engine needed for most cases)
// ---------------------------------------------------------------------------

describe('citation validator', () => {
  beforeEach(async () => { await reset(); });

  async function run(compiled: string, slug = 'concepts/test'): Promise<ReturnType<typeof citationValidator.validate>> {
    return citationValidator.validate({
      slug,
      type: 'concept',
      compiledTruth: compiled,
      timeline: '',
      frontmatter: {},
      engine,
    });
  }

  test('passes paragraph with [Source: ...]', async () => {
    const findings = await run('Alice was a founder [Source: X/garrytan, 2026-04-18].');
    expect(findings).toEqual([]);
  });

  test('passes paragraph with inline URL', async () => {
    const findings = await run('She wrote [an essay](https://example.com/essay) about scaling.');
    expect(findings).toEqual([]);
  });

  test('flags factual paragraph missing citation', async () => {
    const findings = await run('Alice raised $5M in Series A from Sequoia.');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].validator).toBe('citation');
  });

  test('ignores headings', async () => {
    const findings = await run('# Big header\n## Subhead');
    expect(findings).toEqual([]);
  });

  test('ignores key-value lines', async () => {
    const findings = await run('**Status:** Active');
    expect(findings).toEqual([]);
  });

  test('ignores code fences entirely', async () => {
    const findings = await run('```\nThis paragraph inside code has no citation and should NOT trigger\n```');
    expect(findings).toEqual([]);
  });

  test('a [Source:] INSIDE a code fence does NOT satisfy the check for surrounding prose', async () => {
    const compiled = `Alice raised money.

\`\`\`
[Source: fake]
\`\`\``;
    const findings = await run(compiled);
    expect(findings.length).toBeGreaterThan(0);
  });

  test('ignores inline code within paragraph (but paragraph still needs citation)', async () => {
    const compiled = 'Alice shipped `gbrain` last week.';
    const findings = await run(compiled);
    expect(findings).toHaveLength(1);
  });

  test('ignores pure wikilink bullets (See Also style)', async () => {
    const compiled = '- [Alice](../people/alice.md)';
    const findings = await run(compiled);
    expect(findings).toEqual([]);
  });

  test('ignores HTML comments', async () => {
    const compiled = '<!-- This is a note -->';
    const findings = await run(compiled);
    expect(findings).toEqual([]);
  });

  test('ignores blockquotes', async () => {
    const compiled = '> quoted content without citation';
    const findings = await run(compiled);
    expect(findings).toEqual([]);
  });

  test('empty [Source:] marker does NOT satisfy citation check', async () => {
    const findings = await run('Alice raised $5M in Series A from Sequoia [Source:].');
    expect(findings).toHaveLength(1);
    expect(findings[0].validator).toBe('citation');
  });

  test('whitespace-only [Source:   ] marker does NOT satisfy citation check', async () => {
    const findings = await run('Alice raised $5M in Series A from Sequoia [Source:   ].');
    expect(findings).toHaveLength(1);
  });

  test('splitParagraphs handles blank-line separation', () => {
    const input = 'First para.\n\nSecond para.';
    const out = splitParagraphs(input);
    expect(out).toHaveLength(2);
    expect(out[0].startLine).toBe(1);
    expect(out[1].startLine).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Link validator
// ---------------------------------------------------------------------------

describe('link validator', () => {
  beforeEach(async () => { await reset(); });

  test('normalizeToSlug strips relative prefix + .md', () => {
    expect(normalizeToSlug('people/alice.md')).toBe('people/alice');
    expect(normalizeToSlug('../../people/alice.md')).toBe('people/alice');
    expect(normalizeToSlug('/people/alice')).toBe('people/alice');
    expect(normalizeToSlug('companies/acme/labs')).toBe('companies/acme/labs');
  });

  test('normalizeToSlug returns null for non-slug shapes', () => {
    expect(normalizeToSlug('mailto:x@y')).toBeNull();
    expect(normalizeToSlug('just-one-component')).toBeNull();
    expect(normalizeToSlug('x')).toBeNull();
  });

  test('isExternalUrl detects http(s)', () => {
    expect(isExternalUrl('https://example.com')).toBe(true);
    expect(isExternalUrl('http://example.com')).toBe(true);
    expect(isExternalUrl('people/alice.md')).toBe(false);
  });

  test('isNonBrainRef detects mailto/anchor/etc', () => {
    expect(isNonBrainRef('mailto:x@y.com')).toBe(true);
    expect(isNonBrainRef('#section')).toBe(true);
    expect(isNonBrainRef('people/alice.md')).toBe(false);
  });

  test('flags dangling wikilink', async () => {
    const findings = await linkValidator.validate({
      slug: 'people/bob',
      type: 'person',
      compiledTruth: 'Bob met [Alice](../people/alice.md) yesterday [Source: meeting, 2026-04-18]',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('people/alice');
  });

  test('passes when wikilink target exists', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: 'x', frontmatter: {} });
    const findings = await linkValidator.validate({
      slug: 'people/bob',
      type: 'person',
      compiledTruth: 'Bob met [Alice](../people/alice.md).',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });

  test('ignores external URLs', async () => {
    const findings = await linkValidator.validate({
      slug: 'concepts/x',
      type: 'concept',
      compiledTruth: 'Read [this](https://example.com/page) for context.',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });

  test('flags mailto as warning', async () => {
    const findings = await linkValidator.validate({
      slug: 'concepts/x',
      type: 'concept',
      compiledTruth: 'Email [me](mailto:x@y.com).',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings.some(f => f.severity === 'warning')).toBe(true);
  });

  test('ignores links inside fenced code', async () => {
    const compiled = '```\n[link](../people/not-real.md)\n```';
    const findings = await linkValidator.validate({
      slug: 'concepts/x',
      type: 'concept',
      compiledTruth: compiled,
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Back-link validator
// ---------------------------------------------------------------------------

describe('back-link validator', () => {
  beforeEach(async () => { await reset(); });

  test('no outbound links → no findings', async () => {
    await engine.putPage('people/isolated', { type: 'person', title: 'x', compiled_truth: 'x', frontmatter: {} });
    const findings = await backLinkValidator.validate({
      slug: 'people/isolated',
      type: 'person',
      compiledTruth: 'x',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });

  test('outbound link without reverse → warning', async () => {
    await engine.putPage('people/x', { type: 'person', title: 'x', compiled_truth: 'x', frontmatter: {} });
    await engine.putPage('people/y', { type: 'person', title: 'y', compiled_truth: 'y', frontmatter: {} });
    await engine.addLink('people/x', 'people/y', 'mentions', 'mentions');
    // no reverse back-link

    const findings = await backLinkValidator.validate({
      slug: 'people/x',
      type: 'person',
      compiledTruth: 'x',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('people/y');
  });

  test('bidirectional links → no findings', async () => {
    await engine.putPage('people/a', { type: 'person', title: 'a', compiled_truth: 'x', frontmatter: {} });
    await engine.putPage('people/b', { type: 'person', title: 'b', compiled_truth: 'x', frontmatter: {} });
    await engine.addLink('people/a', 'people/b', 'x', 'knows');
    await engine.addLink('people/b', 'people/a', 'x', 'knows_back');

    const findings = await backLinkValidator.validate({
      slug: 'people/a',
      type: 'person',
      compiledTruth: 'x',
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Triple-HR validator
// ---------------------------------------------------------------------------

describe('triple-hr validator', () => {
  test('no issues on clean compiled_truth', async () => {
    const findings = await tripleHrValidator.validate({
      slug: 'people/clean',
      type: 'person',
      compiledTruth: 'Clean content, no bar in compiled_truth.',
      timeline: '- **2026-04-18** | Met',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });

  test('bare --- in compiled_truth flags warning', async () => {
    const compiled = 'Alice did a thing.\n\n---\n\nAnd another.';
    const findings = await tripleHrValidator.validate({
      slug: 'people/dangerous',
      type: 'person',
      compiledTruth: compiled,
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings.some(f => f.message.includes('---'))).toBe(true);
    expect(findings[0].severity).toBe('warning');
  });

  test('--- inside code fence does NOT flag', async () => {
    const compiled = 'Content.\n\n```\n---\nshown as output\n---\n```';
    const findings = await tripleHrValidator.validate({
      slug: 'people/safe',
      type: 'person',
      compiledTruth: compiled,
      timeline: '',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });

  test('heading in timeline → warning', async () => {
    const findings = await tripleHrValidator.validate({
      slug: 'people/spill',
      type: 'person',
      compiledTruth: 'x',
      timeline: '## This should not be here\n- **2026-04-18** | event',
      frontmatter: {},
      engine,
    });
    expect(findings.some(f => f.message.includes('Heading in timeline'))).toBe(true);
  });

  test('## Timeline header line in timeline is allowed', async () => {
    const findings = await tripleHrValidator.validate({
      slug: 'people/ok',
      type: 'person',
      compiledTruth: 'x',
      timeline: '## Timeline\n- **2026-04-18** | event',
      frontmatter: {},
      engine,
    });
    expect(findings).toEqual([]);
  });
});
