/**
 * #4508 — `gbrain think "<q>" --source <id>` used to leak the flag into the
 * question.
 *
 * runThinkCli's flag-strip list lacked `--source` (and `--calibration-holder`),
 * so the flag AND its value joined the positional question: the output echoed
 * `# --source X <question>`, exit 0, and the scope was silently ignored. The
 * CLI now parses --source, validates it (unknown source → exit 1), threads
 * sourceId into runThink, and strips --calibration-holder's value too.
 *
 * runThink is mocked (no LLM, no retrieval) — these tests pin the CLI arg
 * surface only. Source validation runs against a stub engine that knows one
 * source: 'workspace'.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

const captured: { opts: Array<Record<string, unknown>>; persist: Array<Record<string, unknown>>; take: Array<Record<string, unknown>> } = { opts: [], persist: [], take: [] };
/** GST-3612: what the mocked writers answer: a save accepted but still publishing, and the take's result. */
const writers: { savePending: boolean; takeRow: number | null } = { savePending: false, takeRow: 1 };
const { OperationError } = await import('../src/core/ops/contract.ts');

const stubResult = {
  answer: 'Stub answer.',
  citations: [],
  gaps: [],
  warnings: [],
  modelUsed: 'none',
  pagesGathered: 0,
  takesGathered: 0,
  graphHits: 0,
};

mock.module('../src/core/think/index.ts', () => ({
  runThink: async (_engine: unknown, opts: Record<string, unknown>) => {
    captured.opts.push(opts);
    return JSON.parse(JSON.stringify(stubResult));
  },
  persistSynthesis: async (_engine: unknown, _result: unknown, opts: Record<string, unknown> = {}) => {
    captured.persist.push(opts);
    if (writers.savePending) throw new OperationError('write_pending', 'The synthesis page has not committed: request save-request-example.', 'Poll gbrain write-request save-request-example.');
    return { slug: 'synthesis/stub', evidenceInserted: 0, warnings: [] };
  },
  stripGapsSection: (s: string) => s,
}));

mock.module('../src/core/think/persist-take.ts', () => ({
  persistTakeFromSynthesis: async (_engine: unknown, _result: unknown, opts: Record<string, unknown>) => {
    captured.take.push(opts);
    return writers.takeRow === null ? { take_row: null, warnings: ['TAKE_WRITE_FAILED: page_not_found'] } : { take_row: writers.takeRow, warnings: [] };
  },
}));

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({
  ...realConfig,
  isThinClient: () => false,
}));

// #4652: pin the ambient tier. The stub engine has no getConfig, so the real
// tier-5 lookup would throw and a swallow-into-legacy-unscoped path would
// look identical to the bug. Explicit ids still hit the real resolver so the
// unknown-source exit-1 contract below stays real.
const realResolver = await import('../src/core/source-resolver.ts');
// Bind the real function BEFORE mocking: the namespace binding is re-pointed
// at the mock, so calling through `realResolver.` later would recurse.
const realResolveSourceWithTier = realResolver.resolveSourceWithTier;
/** What the AMBIENT (no --source) resolution does; tests flip it per case. */
const ambient: { mode: 'default' | 'target_error' | 'structural' } = { mode: 'default' };
mock.module('../src/core/source-resolver.ts', () => ({
  ...realResolver,
  resolveSourceWithTier: async (engine: unknown, explicit: string | null | undefined) => {
    if (explicit) return realResolveSourceWithTier(engine as never, explicit);
    if (ambient.mode === 'target_error') {
      throw new realResolver.SourceTargetError('Source "ghost-src" not found or is archived.');
    }
    if (ambient.mode === 'structural') throw new Error('relation "sources" does not exist');
    return { source_id: 'default', tier: 'seed_default' as const };
  },
  localFederatedSourceIds: async (_engine: unknown, _id: string, tier: string) =>
    tier === 'seed_default' ? ['default', 'team-wiki'] : undefined,
}));

import { stubSourceMembers } from './helpers/source-members-stub.ts';

const { runThinkCli } = await import('../src/commands/think.ts');

/** Stub engine: assertSourceExists's read resolves only 'workspace'. */
const stubEngine = {
  ...stubSourceMembers([{ id: 'workspace' }]),
} as never;

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitSentinel';
  }
}

async function runCli(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const savedStderr = process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  try {
    await runThinkCli(stubEngine, args);
    return { code: 0, out, err };
  } catch (e) {
    if (e instanceof ExitSentinel) return { code: e.code, out, err };
    throw e;
  } finally {
    console.log = savedLog;
    console.error = savedError;
    process.stderr.write = savedStderr;
    (process as unknown as { exit: typeof savedExit }).exit = savedExit;
  }
}

beforeEach(() => {
  captured.opts.length = 0; captured.persist.length = 0; captured.take.length = 0;
  writers.savePending = false; writers.takeRow = 1;
});

describe('#4508 think --source CLI surface', () => {
  test('--source is parsed out of the question and threaded into runThink', async () => {
    const r = await runCli(['what', 'is', 'acme-example', '--source', 'workspace']);
    expect(r.code).toBe(0);
    // The question header is pure — pre-fix it read "# --source workspace what is acme-example".
    expect(r.out[0]).toBe('# what is acme-example\n');
    expect(captured.opts).toHaveLength(1);
    expect(captured.opts[0].question).toBe('what is acme-example');
    expect(captured.opts[0].sourceId).toBe('workspace');
  });

  test('an unknown --source is rejected with exit 1 (never silently ignored)', async () => {
    const r = await runCli(['what', 'is', 'acme-example', '--source', 'nope-source']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('nope-source');
    expect(captured.opts).toHaveLength(0); // never reached runThink
  });

  test('--calibration-holder value no longer leaks into the question', async () => {
    const r = await runCli(['a', 'question', '--with-calibration', '--calibration-holder', 'holder-example']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('# a question\n');
    expect(captured.opts[0].question).toBe('a question');
    expect(captured.opts[0].calibrationHolder).toBe('holder-example');
  });

  // #4652: without --source, think used to hand runThink no scope at all, so
  // the gather spanned every source (including `--no-federated` ones) while
  // `gbrain search` on the same brain honored the resolved default + its
  // federated set. The CLI now resolves the same scope search does.
  test('omitting --source resolves the default source and its federated set (#4652)', async () => {
    const r = await runCli(['plain', 'question']);
    expect(r.code).toBe(0);
    expect(captured.opts[0].sourceId).toBe('default');
    expect(captured.opts[0].allowedSources).toEqual(['default', 'team-wiki']);
  });

  test('explicit --source stays scalar (no federated widening)', async () => {
    const r = await runCli(['plain', 'question', '--source', 'workspace']);
    expect(r.code).toBe(0);
    expect(captured.opts[0].sourceId).toBe('workspace');
    expect(captured.opts[0].allowedSources).toBeUndefined();
  });

  test('--source __all__ spans the brain instead of scoping to the literal sentinel', async () => {
    const r = await runCli(['plain', 'question', '--source', '__all__']);
    expect(r.code).toBe(0);
    expect(captured.opts[0].sourceId).toBeUndefined();
    expect(captured.opts[0].allowedSources).toBeUndefined();
  });

  test('think --help documents --source', async () => {
    const r = await runCli(['--help']);
    expect(r.out.join('\n')).toContain('--source');
  });

  // Wave review: the catch used to swallow EVERY ambient resolver error into
  // an unscoped gather — only the structural pre-init failure may do that.
  test('an ambient SourceTargetError (stale GBRAIN_SOURCE / dotfile) is exit 1, never an unscoped gather', async () => {
    ambient.mode = 'target_error';
    try {
      const r = await runCli(['plain', 'question']);
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toContain('ghost-src');
      expect(captured.opts).toHaveLength(0);
    } finally {
      ambient.mode = 'default';
    }
  });

  test('a structural pre-init failure (no sources table) keeps the legacy unscoped gather', async () => {
    ambient.mode = 'structural';
    try {
      const r = await runCli(['plain', 'question']);
      expect(r.code).toBe(0);
      expect(captured.opts).toHaveLength(1);
      expect(captured.opts[0].sourceId).toBeUndefined();
      expect(captured.opts[0].allowedSources).toBeUndefined();
    } finally {
      ambient.mode = 'default';
    }
  });
});

describe('think --save writes to the resolved source', () => {
  test('an explicit --source saves into that source only', async () => {
    const r = await runCli(['plain', 'question', '--source', 'workspace', '--save']);
    expect(r.code).toBe(0);
    expect(captured.persist).toEqual([{ sourceId: 'workspace', allowedSources: undefined }]);
  });

  test('the ambient default saves into the default source, bound to its federated set', async () => {
    const r = await runCli(['plain', 'question', '--save']);
    expect(r.code).toBe(0);
    expect(captured.persist).toEqual([{ sourceId: 'default', allowedSources: ['default', 'team-wiki'] }]);
  });

  test('--source __all__ is a read scope, so the save carries no source', async () => {
    const r = await runCli(['plain', 'question', '--source', '__all__', '--save']);
    expect(r.code).toBe(0);
    expect(captured.persist).toEqual([{ sourceId: undefined, allowedSources: undefined }]);
  });

  test('the local think operation saves into the caller source and never into the __all__ sentinel', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const engine = { kind: 'pglite', executeRaw: async () => [], getConfig: async () => null } as never;
    const ctx = (sourceId: string) => ({ engine, remote: false, sourceId, config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} } }) as never;
    await operationsByName.think.handler(ctx('workspace'), { question: 'plain question', save: true });
    await operationsByName.think.handler(ctx('__all__'), { question: 'plain question', save: true });
    expect(captured.persist).toEqual([{ sourceId: 'workspace' }, { sourceId: undefined }]);
  });
});

describe('think --take writes to the resolved source (GST-3612)', () => {
  test('an explicit --source appends the take in that source', async () => {
    const r = await runCli(['plain', 'question', '--source', 'workspace', '--take', '--anchor', 'people/alice-example']);
    expect(r.code).toBe(0);
    expect(captured.take).toEqual([{ anchor: 'people/alice-example', sourceId: 'workspace' }]);
  });

  test('a save still publishing prints the answer, then exits 10 with its receipt', async () => {
    writers.savePending = true;
    const r = await runCli(['plain', 'question', '--save']);
    expect(r.code).toBe(10);
    expect(r.out.join('\n')).toContain('Stub answer.');
    expect(r.err.join('\n')).toContain('save-request-example');
  });

  test('a save still publishing keeps its receipt when the take is then refused', async () => {
    writers.savePending = true; writers.takeRow = null;
    const r = await runCli(['plain', 'question', '--save', '--take', '--anchor', 'people/alice-example']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('no take row was appended');
    expect(r.err.join('\n')).toContain('save-request-example');
  });

  test('the local think operation appends the take in the caller source and never in the __all__ sentinel', async () => {
    const { operationsByName } = await import('../src/core/operations.ts');
    const engine = { kind: 'pglite', executeRaw: async () => [], getConfig: async () => null } as never;
    const ctx = (sourceId: string) => ({ engine, remote: false, sourceId, config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} } }) as never;
    await operationsByName.think.handler(ctx('workspace'), { question: 'plain question', take: true, anchor: 'people/alice-example' });
    await operationsByName.think.handler(ctx('__all__'), { question: 'plain question', take: true, anchor: 'people/alice-example' });
    expect(captured.take.map(t => t.sourceId)).toEqual(['workspace', undefined]);
  });
});
