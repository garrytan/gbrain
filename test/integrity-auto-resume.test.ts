import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type FakePage = {
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
};

const originalIntegrityDir = process.env.GBRAIN_INTEGRITY_DIR;
const testRoot = mkdtempSync(join(tmpdir(), 'integrity-auto-'));
const GBRAIN_DIR = join(testRoot, 'gbrain');
process.env.GBRAIN_INTEGRITY_DIR = GBRAIN_DIR;
const REVIEW_FILE = join(GBRAIN_DIR, 'integrity-review.md');
const LOG_FILE = join(GBRAIN_DIR, 'integrity.log.jsonl');
const PROGRESS_FILE = join(GBRAIN_DIR, 'integrity-progress.jsonl');

let pages = new Map<string, FakePage>();
let resolverCalls: Array<{ name: string; input: unknown }> = [];
let resolverImpl: (name: string, input: unknown) => Promise<{ confidence: number; value: any }>;

const fakeEngine: any = {
  connect: async () => {},
  disconnect: async () => {},
  getAllSlugs: async () => [...pages.keys()],
  getPage: async (slug: string) => pages.get(slug) ?? null,
  putPage: async (slug: string, input: any) => {
    const existing = pages.get(slug);
    if (!existing) return;
    pages.set(slug, {
      type: input.type,
      title: input.title,
      compiled_truth: input.compiled_truth,
      timeline: input.timeline,
      frontmatter: input.frontmatter ?? existing.frontmatter,
    });
  },
  addTimelineEntry: async (slug: string, entry: any) => {
    const existing = pages.get(slug);
    if (!existing) return;
    const line = `- **${entry.date}** | ${entry.summary}${entry.detail ? ` ${entry.detail}` : ''}`;
    pages.set(slug, {
      ...existing,
      timeline: existing.timeline ? `${existing.timeline}\n${line}` : line,
    });
  },
  transaction: async (fn: (txEngine: unknown) => Promise<unknown>) => fn(fakeEngine),
};

mock.module('../src/core/config.ts', () => ({
  loadConfig: () => ({ engine: 'mock', database_path: join(testRoot, 'db') }),
  toEngineConfig: (config: unknown) => config,
}));

mock.module('../src/core/engine-factory.ts', () => ({
  createEngine: async () => fakeEngine,
}));

mock.module('../src/core/resolvers/index.ts', () => ({
  getDefaultRegistry: () => ({
    resolve: async (name: string, input: unknown) => {
      resolverCalls.push({ name, input });
      return resolverImpl(name, input);
    },
  }),
}));

mock.module('../src/commands/resolvers.ts', () => ({
  registerBuiltinResolvers: () => {},
}));

const { runIntegrity } = await import('../src/commands/integrity.ts');

function readJsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function reviewEntryCount(): number {
  if (!existsSync(REVIEW_FILE)) return 0;
  return (readFileSync(REVIEW_FILE, 'utf-8').match(/^## /gm) ?? []).length;
}

beforeEach(() => {
  rmSync(GBRAIN_DIR, { recursive: true, force: true });
  pages = new Map<string, FakePage>();
  resolverCalls = [];
  resolverImpl = async (name: string) => {
    if (name === 'x_handle_to_tweet') {
      return {
        confidence: 0.6,
        value: {
          candidates: [
            {
              tweet_id: '123',
              text: 'candidate',
              created_at: '2026-01-01T00:00:00Z',
              score: 0.6,
              url: 'https://x.com/alice/status/123',
            },
          ],
        },
      };
    }
    return { confidence: 1, value: { reachable: true } };
  };
});

afterAll(() => {
  process.env.GBRAIN_INTEGRITY_DIR = originalIntegrityDir;
  rmSync(testRoot, { recursive: true, force: true });
});

describe('integrity auto durable resume', () => {
  test('resumes unfinished multi-hit slugs from per-hit checkpoint', async () => {
    pages.set('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: [
        'Alice tweeted about launch plans.',
        'She posted on X again this week.',
      ].join('\n'),
      timeline: '',
      frontmatter: { x_handle: 'alice' },
    });

    mkdirSync(GBRAIN_DIR, { recursive: true });
    writeFileSync(
      PROGRESS_FILE,
      JSON.stringify({
        slug: 'people/alice',
        status: 'reviewed',
        timestamp: '2026-04-20T00:00:00.000Z',
        kind: 'bare_tweet_hit',
        hitIndex: 0,
      }) + '\n',
      'utf-8',
    );
    writeFileSync(
      REVIEW_FILE,
      '## people/alice:1  (confidence 0.60)\n\n---\n\n',
      'utf-8',
    );

    await runIntegrity(['auto']);

    expect(resolverCalls.filter(call => call.name === 'x_handle_to_tweet')).toHaveLength(1);
    expect(reviewEntryCount()).toBe(2);

    const progressEntries = readJsonLines(PROGRESS_FILE);
    expect(progressEntries.some(e => e.kind === 'bare_tweet_hit' && e.hitIndex === 1)).toBe(true);
    expect(progressEntries.some(e => e.kind === 'complete')).toBe(true);
  });

  test('dead-link-only slugs are checkpointed and not re-logged on rerun', async () => {
    pages.set('concepts/dead-link-only', {
      type: 'concept',
      title: 'Dead Link',
      compiled_truth: 'See [old source](https://example.com/dead).',
      timeline: '',
      frontmatter: {},
    });

    resolverImpl = async (name: string) => {
      if (name === 'url_reachable') {
        return { confidence: 1, value: { reachable: false, reason: '404' } };
      }
      return {
        confidence: 0.6,
        value: {
          candidates: [],
        },
      };
    };

    await runIntegrity(['auto']);
    const firstLogCount = readJsonLines(LOG_FILE).length;

    await runIntegrity(['auto']);
    const secondLogCount = readJsonLines(LOG_FILE).length;

    expect(firstLogCount).toBe(1);
    expect(secondLogCount).toBe(1);

    const progressEntries = readJsonLines(PROGRESS_FILE);
    expect(progressEntries.some(e => e.kind === 'dead_link_scan')).toBe(true);
    expect(progressEntries.some(e => e.kind === 'complete')).toBe(true);
  });

  test('auto-repair writes citation into compiled truth and re-enables validators', async () => {
    pages.set('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice tweeted about launch plans.',
      timeline: '',
      frontmatter: { x_handle: 'alice', validate: false },
    });

    resolverImpl = async (name: string) => {
      if (name === 'x_handle_to_tweet') {
        return {
          confidence: 0.95,
          value: {
            url: 'https://x.com/alice/status/123',
            tweet_id: '123',
            created_at: '2026-01-02T00:00:00Z',
            candidates: [],
          },
        };
      }
      return { confidence: 1, value: { reachable: true } };
    };

    await runIntegrity(['auto']);

    const updated = pages.get('people/alice');
    expect(updated).toBeDefined();
    expect(updated!.compiled_truth).toContain('https://x.com/alice/status/123');
    expect(updated!.compiled_truth).toContain('[Source: [X/alice, 2026-01-02]');
    expect(updated!.frontmatter.validate).toBe(true);
  });
});
