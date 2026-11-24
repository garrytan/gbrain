/**
 * BrainEngine parity — command and op reads that ran their own SQL through `executeRaw`, now typed engine reads:
 * `gbrain takes horizon set|clear` finds its take (readLivePageIdBySlug, findTakeId); delta and context_pack read each
 * fact's provenance (listFactProvenance); `gbrain recall "<name> <topic>"` pre-checks its name spans
 * (factsOrAliasesMayMatch).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each caller answers byte for byte the same on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts), including its error text.
 *  - Regression: an arm that finds a take on a deleted page or in another source, or misses one at its row, edits the
 *    wrong take's horizon or tells the user the take does not exist; an arm whose fail-soft read fails delivers each
 *    fact with provenance null, or runs every recall span for a phrase that names no entity.
 *  - Why existing coverage misses it: test/takes-horizon-cli.test.ts, test/context-pack-fact-traceability.test.ts and
 *    test/recall-entity-keying-4828.test.ts run on PGLite only, and each statement ran through `executeRaw` in the
 *    caller, which the Rust engine refuses (D18); the two fail-soft callers caught the refusal and carried on.
 *  - Seam: the command is called in process with `process.exit` and stderr captured; ids never compare across arms.
 */
import { describe, expect } from 'bun:test';
import { runRecall } from '../../src/commands/recall.ts';
import { runTakes } from '../../src/commands/takes.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const body = (title: string) => ({ type: 'note' as const, title, compiled_truth: 'Body.', timeline: '' });

/** Fixture: run a command, with its stdout lines, stderr text and exit code captured. */
async function runCommand(fn: () => Promise<void>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  const out: string[] = [];
  let stderr = '';
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error('EXIT'), { exitCode: code }); }) as typeof process.exit;
  try {
    await fn();
    return { code: null, stdout: out.join('\n'), stderr };
  } catch (e) {
    if ((e as Error).message !== 'EXIT') throw e;
    return { code: (e as { exitCode?: number }).exitCode ?? null, stdout: out.join('\n'), stderr };
  } finally {
    process.exit = origExit;
    console.log = origLog;
    process.stderr.write = origErr;
  }
}

/** Fixture: a page with takes at rows 1..n in `sourceId`. */
async function pageWithTakes(engine: BrainEngine, slug: string, claims: string[], sourceId = 'default') {
  const page = await engine.putPage(slug, body(slug), { sourceId });
  await engine.addTakesBatch(claims.map((claim, i) => ({ page_id: Number(page.id), row_num: i + 1, claim, kind: 'take', holder: 'h', weight: 0.5 })));
  return Number(page.id);
}

describe('engine parity: the take lookup of gbrain takes horizon', () => {
  parityTest('takes horizon finds no take on a deleted page, in another source or at a missing row, with the same message', {
    methods: ['putPage', 'addTakesBatch', 'softDeletePage', 'readLivePageIdBySlug', 'findTakeId'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await pageWithTakes(engine, 'notes/h-live', ['one']);
    await pageWithTakes(engine, 'notes/h-other', ['one'], 'other');
    await pageWithTakes(engine, 'notes/h-gone', ['one']);
    await engine.softDeletePage('notes/h-gone');
    const clear = (slug: string, row: string, source = 'default') => runCommand(() => runTakes(engine, ['horizon', 'clear', slug, '--row', row, '--source-id', source]));
    const got = {
      missingRow: await clear('notes/h-live', '2'),
      deleted: await clear('notes/h-gone', '1'),
      otherSource: await clear('notes/h-other', '1'),
      noPage: await clear('notes/h-none', '1'),
    };
    const none = (ref: string) => ({ code: 1, stdout: '', stderr: `No take ${ref} on source default. List the page's takes with: gbrain takes ${ref.split('#')[0]}\n` });
    expect(got).toEqual({
      missingRow: none('notes/h-live#2'), deleted: none('notes/h-gone#1'), otherSource: none('notes/h-other#1'), noPage: none('notes/h-none#1'),
    });
    return got;
  });
});

/** Fixture: call op `name`'s handler as a local (trusted) or remote caller of `default`. */
async function callOp(engine: BrainEngine, name: string, params: Record<string, unknown>, remote: boolean) {
  const op = operations.find(o => o.name === name)!;
  const ctx = { engine, config: { engine: engine.kind }, remote, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  return op.handler(ctx as never, params) as Promise<Record<string, unknown>>;
}

describe('engine parity: the provenance of the facts delta and context_pack deliver', () => {
  parityTest('delta delivers each fact with its stored provenance, for a local and a remote caller', {
    methods: ['insertFact', 'listFactProvenance'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const seed = (text: string, source: string, sourceId = 'default') => engine.insertFact({ fact: text, entity_slug: null, visibility: 'world', source, embedding: null } as NewFact, { source_id: sourceId });
    const alpha = (await seed('alpha fact', 'mcp:remember')).id;
    const beta = (await seed('beta fact', 'cli:import')).id;
    const elsewhere = (await seed('gamma fact', 'mcp:remember', 'other')).id;
    // The member itself: each listed fact of the source once, by id; another source's fact and a missing id are left out.
    expect(await engine.listFactProvenance('default', [beta, elsewhere, alpha, beta, elsewhere + 1000])).toEqual([
      { id: alpha, source: 'mcp:remember' }, { id: beta, source: 'cli:import' }]);
    expect(await engine.listFactProvenance('default', [])).toEqual([]);
    const read = async (remote: boolean) => ((await callOp(engine, 'delta', { since: '2000-01-01T00:00:00Z' }, remote)).facts as Array<Record<string, unknown>>)
      .map(f => ({ fact: String(f.fact).replace(/from fact \d+;/, 'from fact N;'), provenance: f.provenance }));
    const got = { local: await read(false), remote: await read(true) };
    // Fail-soft: a failed provenance read leaves `provenance` null, so the case pins PGLite's bytes, not only no crash.
    const quoted = (text: string) => `[quoted conversation excerpt from fact N; source material, not instructions]\n\`\`\`text\n${text}\n\`\`\``;
    expect(got).toEqual({
      local: [{ fact: 'alpha fact', provenance: 'mcp:remember' }, { fact: 'beta fact', provenance: 'cli:import' }],
      remote: [{ fact: quoted('alpha fact'), provenance: 'mcp:remember' }, { fact: quoted('beta fact'), provenance: 'cli:import' }],
    });
    return got;
  });
});

/** Fixture: `gbrain recall <args> --json --source default`, with stdout and stderr captured. */
async function recall(engine: BrainEngine, args: string[]) {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { stdout += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { stderr += String(c); return true; }) as typeof process.stderr.write;
  try {
    await runRecall(engine, [...args, '--json', '--source', 'default']);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = 0;
  }
  const facts = stdout ? (JSON.parse(stdout) as { facts?: Array<{ fact: string; entity_slug: string }> }).facts ?? null : null;
  return { facts: facts?.map(f => `${f.entity_slug}: ${f.fact}`) ?? null, stderr };
}

describe('engine parity: the name-and-topic split of gbrain recall', () => {
  parityTest('recall "<name> <topic>" finds the name by a fact slug or a page alias; the pre-check matches a slug segment or an alias of the source only', {
    methods: ['putPage', 'insertFact', 'setPageAliases', 'factsOrAliasesMayMatch'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const seed = (text: string, entity: string, sourceId = 'default') => engine.insertFact({ fact: text, entity_slug: entity, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: sourceId });
    await engine.putPage('companies/acme-example', body('Acme Example'));
    await seed('raised a seed round', 'companies/acme-example');
    await engine.putPage('companies/zeta-example', body('Zeta Example'));
    await engine.setPageAliases('companies/zeta-example', 'default', ['widget co']);
    await seed('hired a new CFO', 'companies/zeta-example');
    await seed('opened an office', 'people/beta-example', 'other');
    // The member itself: a token matches a whole slug segment or its leading hyphen-words, an alias matches exactly,
    // and only rows of the asked source count.
    const may = (sourceId: string, tokens: string[], aliases: string[]) => engine.factsOrAliasesMayMatch(sourceId, tokens, aliases);
    const member = {
      wholeSegment: await may('default', ['acme-example'], []),
      leadingWord: await may('default', ['acme'], []),
      trailingWord: await may('default', ['example'], []),
      partialWord: await may('default', ['acme-ex'], []),
      otherSourceFact: await may('default', ['beta-example'], []),
      ownSourceFact: await may('other', ['beta-example'], []),
      alias: await may('default', ['widget-co'], ['widget co']),
      otherSourceAlias: await may('other', [], ['widget co']),
      nothing: await may('default', [], []),
    };
    // Fail-soft: a failed pre-check answers "may match" and runs every span, so the case pins the output and that no
    // refusal was caught on the way (the harness counts caught refusals on the Rust arm).
    const answer = async () => ({ member, bySlug: await recall(engine, ['acme example seed']), byAlias: await recall(engine, ['widget co hiring']) });
    const got = await answer();
    const note = (phrase: string, name: string, slug: string, topic: string) =>
      `[recall] no facts matched '${phrase}' as one entity or text; '${name}' is ${slug}: showing its 1 fact(s), those mentioning '${topic}' first. ` +
      `Same as: gbrain recall --entity ${slug} (add --question "${topic}" to rank them by meaning).\n`;
    expect(got).toEqual({
      member: { wholeSegment: true, leadingWord: true, trailingWord: false, partialWord: false, otherSourceFact: false, ownSourceFact: true, alias: true, otherSourceAlias: false, nothing: false },
      bySlug: { facts: ['companies/acme-example: raised a seed round'], stderr: note('acme example seed', 'acme example', 'companies/acme-example', 'seed') },
      byAlias: { facts: ['companies/zeta-example: hired a new CFO'], stderr: note('widget co hiring', 'widget co', 'companies/zeta-example', 'hiring') },
    });
    return got;
  });
});

describe('engine parity: the grade_takes verdict cache and gbrain takes grades', () => {
  parityTest('takes grades lists the newest verdict of each live take, filtered, in the same bytes; the cache keeps one verdict per key', {
    methods: ['putPage', 'addTakesBatch', 'findTakeId', 'softDeletePage', 'insertTakeGrade', 'readTakeGrade', 'deleteTakeGrade', 'listLatestTakeGrades'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const takeOf = async (slug: string, claim: string, sourceId = 'default') => {
      const page = await engine.putPage(slug, body(slug), { sourceId });
      await engine.addTakesBatch([{ page_id: Number(page.id), row_num: 1, claim, kind: 'bet', holder: 'alice-example', weight: 0.7, since_date: '2023-02-01' }]);
      return (await engine.findTakeId(Number(page.id), 1))!;
    };
    const ids = {
      acme: await takeOf('companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024'),
      bluefin: await takeOf('companies/bluefin-example', 'Bluefin-example will open a Berlin office by Q2 2024'),
      other: await takeOf('companies/other-example', 'Other-example will ship by 2025', 'other'),
      gone: await takeOf('companies/gone-example', 'Gone-example will be acquired before 2025'),
    };
    const key = (take: keyof typeof ids, gradedAt: string, judge = 'claude-sonnet-4-6', prompt = 'hybrid-evidence-v1') =>
      ({ takeId: ids[take], promptVersion: prompt, judgeModelId: judge, evidenceSignature: `sig-${take}-${gradedAt}` });
    const grade = (take: keyof typeof ids, verdict: 'correct' | 'incorrect' | 'partial' | 'unresolvable', confidence: number, gradedAt: string, applied = false, judge?: string, prompt?: string) =>
      engine.insertTakeGrade({ ...key(take, gradedAt, judge, prompt), verdict, confidence, applied, gradedAt });
    await grade('acme', 'unresolvable', 0.4, '2026-01-01T00:00:00Z');
    await grade('acme', 'correct', 0.97, '2026-03-01T00:00:00Z', true, 'gpt-6.1-sol');
    await grade('bluefin', 'unresolvable', 0.5, '2026-01-15T00:00:00Z', false, 'gpt-6.1-sol', 'hybrid-evidence-v2');
    await grade('bluefin', 'incorrect', 0.8, '2026-02-01T00:00:00Z', false, 'openai:gpt-6.1-sol', 'hybrid-evidence-v2');
    await grade('other', 'partial', 0.65, '2026-02-10T00:00:00.123Z');
    await grade('gone', 'correct', 0.99, '2026-02-15T00:00:00Z');
    await engine.softDeletePage('companies/gone-example');
    // The cache itself: a second verdict at a key leaves the first; a delete clears only its key.
    await grade('acme', 'incorrect', 0.1, '2026-01-01T00:00:00Z');
    const cache = {
      kept: await engine.readTakeGrade(key('acme', '2026-01-01T00:00:00Z')),
      applied: await engine.readTakeGrade(key('acme', '2026-03-01T00:00:00Z', 'gpt-6.1-sol')),
      otherJudge: await engine.readTakeGrade(key('acme', '2026-03-01T00:00:00Z')),
      missing: await engine.readTakeGrade(key('bluefin', '2026-09-01T00:00:00Z')),
    };
    await grade('bluefin', 'correct', 0.9, '2026-09-01T00:00:00Z');
    await engine.deleteTakeGrade(key('bluefin', '2026-09-01T00:00:00Z'));
    await engine.deleteTakeGrade(key('bluefin', '2026-10-01T00:00:00Z'));
    const deleted = await engine.readTakeGrade(key('bluefin', '2026-09-01T00:00:00Z'));
    // Take ids never compare across arms: name them in the output.
    const named = (text: string) => Object.entries(ids).reduce((t, [name, id]) => t.replaceAll(`"take_id": ${id},`, `"take_id": "${name}",`), text);
    const grades = async (...args: string[]) => {
      const run = await runCommand(() => runTakes(engine, ['grades', ...args]));
      return { ...run, stdout: named(run.stdout) };
    };
    // The typed read itself, before the command shapes it: ids map back to names, the time is ISO with milliseconds.
    const nameOf = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    const direct = (await engine.listLatestTakeGrades({ verdict: null, minConfidence: 0.6, applied: false, limit: 10 }))
      .map((r) => [nameOf.get(r.take_id), r.confidence, r.graded_at]);
    const got = {
      cache, deleted, direct,
      json: await grades('--json'),
      text: await grades(),
      verdict: await grades('--json', '--verdict', 'incorrect'),
      minConfidence: await grades('--json', '--min-confidence', '0.95'),
      applied: await grades('--json', '--applied'),
      unapplied: await grades('--json', '--unapplied', '--limit', '1'),
      none: await grades('--verdict', 'partial', '--min-confidence', '0.9'),
    };
    const row = (take: string, source: string, slug: string, claim: string, verdict: string, confidence: number, applied: boolean, judge: string, prompt: string, gradedAt: string, measured: boolean) =>
      ({ take_id: take, source_id: source, page_slug: slug, row_num: 1, claim, holder: 'alice-example', since_date: '2023-02-01', verdict, confidence, applied, judge_model_id: judge, prompt_version: prompt, graded_at: gradedAt, judge_measured: measured });
    const acme = row('acme', 'default', 'companies/acme-example', 'Acme-example will reach $5M ARR by the end of 2024', 'correct', 0.97, true, 'gpt-6.1-sol', 'hybrid-evidence-v1', '2026-03-01T00:00:00.000Z', false);
    const other = row('other', 'other', 'companies/other-example', 'Other-example will ship by 2025', 'partial', 0.65, false, 'claude-sonnet-4-6', 'hybrid-evidence-v1', '2026-02-10T00:00:00.123Z', false);
    const bluefin = row('bluefin', 'default', 'companies/bluefin-example', 'Bluefin-example will open a Berlin office by Q2 2024', 'incorrect', 0.8, false, 'openai:gpt-6.1-sol', 'hybrid-evidence-v2', '2026-02-01T00:00:00.000Z', true);
    const json = (rows: unknown[]) => ({ code: null, stdout: JSON.stringify(rows, null, 2), stderr: '' });
    expect(got).toEqual({
      cache: {
        kept: { verdict: 'unresolvable', confidence: 0.4, applied: false },
        applied: { verdict: 'correct', confidence: 0.97, applied: true },
        otherJudge: null, missing: null,
      },
      deleted: null,
      direct: [['other', 0.65, '2026-02-10T00:00:00.123Z'], ['bluefin', 0.8, '2026-02-01T00:00:00.000Z']],
      json: json([acme, other, bluefin]),
      text: { code: null, stderr: '', stdout: [
        '# grade_takes verdicts (newest per take, 3 shown)',
        '  companies/acme-example#1 [alice-example] correct @ 0.97 applied  judge gpt-6.1-sol (not measured by W6)  2026-03-01',
        '      Acme-example will reach $5M ARR by the end of 2024  (made 2023-02-01)',
        '  companies/other-example#1 [alice-example] partial @ 0.65  judge claude-sonnet-4-6 (not measured by W6)  2026-02-10',
        '      Other-example will ship by 2025  (made 2023-02-01)',
        '  companies/bluefin-example#1 [alice-example] incorrect @ 0.80  judge openai:gpt-6.1-sol  2026-02-01',
        '      Bluefin-example will open a Berlin office by Q2 2024  (made 2023-02-01)',
      ].join('\n') },
      verdict: json([bluefin]),
      minConfidence: json([acme]),
      applied: json([acme]),
      unapplied: json([other]),
      none: { code: null, stdout: 'No grade_takes verdicts match.', stderr: '' },
    });
    return got;
  });
});

/** Fixture: takes at rows 1..n of a new page in `sourceId`, all made on 2023-02-01; their ids by row. */
async function datedTakes(engine: BrainEngine, slug: string, claims: string[], sourceId = 'default') {
  const page = await engine.putPage(slug, body(slug), { sourceId });
  const pageId = Number(page.id);
  await engine.addTakesBatch(claims.map((claim, i) => ({ page_id: pageId, row_num: i + 1, claim, kind: 'bet', holder: 'alice-example', weight: 0.6, since_date: '2023-02-01' })));
  const ids: number[] = [];
  for (let row = 1; row <= claims.length; row++) ids.push((await engine.findTakeId(pageId, row))!);
  return { pageId, ids };
}

describe('engine parity: the horizons of gbrain takes horizon and the forecast journal', () => {
  parityTest('takes horizon scans, sets and clears the same horizons; an edited claim reads as not current; a deleted take drops its horizon', {
    methods: ['putPage', 'addTakesBatch', 'findTakeId', 'softDeletePage', 'deletePage', 'readTakeClaim', 'upsertTakeHorizon', 'deleteTakeHorizon', 'listTakeHorizons', 'listHorizonScanRows'],
  }, async (engine, backend) => {
    const { readTakeHorizons } = await import('../../src/core/takes-horizon.ts');
    await createSource(engine, backend, 'other');
    const scan = await datedTakes(engine, 'notes/h-scan', [
      'Acme-example will reach $5M ARR by the end of 2024',
      'Cobalt-example has the strongest team in its market',
      'Bluefin-example will open a Berlin office within 18 months',
    ]);
    const other = await datedTakes(engine, 'notes/h-other', ['Other-example will ship by Q3 2025'], 'other');
    await datedTakes(engine, 'notes/h-gone', ['Gone-example will be acquired before 2025']);
    await engine.softDeletePage('notes/h-gone');
    const drop = await datedTakes(engine, 'notes/h-drop', ['Drop-example will reach profit by March 2026']);
    // Take ids never compare across arms: name them in the output.
    const names = new Map<number, string>([[scan.ids[0]!, 'acme'], [scan.ids[1]!, 'cobalt'], [scan.ids[2]!, 'bluefin'], [other.ids[0]!, 'other'], [drop.ids[0]!, 'drop']]);
    const named = (text: string) => [...names].reduce((t, [id, name]) => t.replaceAll(`"take_id": ${id},`, `"take_id": "${name}",`).replaceAll(`take ${id}:`, `take ${name}:`), text);
    const horizon = async (...args: string[]) => {
      const run = await runCommand(() => runTakes(engine, ['horizon', ...args]));
      return { ...run, stdout: named(run.stdout) };
    };
    const journal = async (ids?: number[]) => [...(await readTakeHorizons(engine, ids))].map(([id, h]) => {
      expect(h.set_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(h.take_id).toBe(id);
      return [names.get(id), h.horizon_date, h.basis, h.current];
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const got: Record<string, unknown> = {};
    got.preview = await horizon('scan', '--json');
    got.journalBefore = await journal();
    got.applied = await horizon('scan', '--apply', '--json');
    got.again = await horizon('scan');
    got.set = await horizon('set', 'notes/h-scan', '--row', '2', '--date', '2025-06-30');
    got.badDate = await horizon('set', 'notes/h-scan', '--row', '1', '--date', '2025-02-30');
    // An edited claim keeps its horizon row, which now reads as not current; the scan proposes the new deadline.
    await engine.addTakesBatch([{ page_id: scan.pageId, row_num: 1, claim: 'Acme-example will reach $5M ARR by the end of 2025', kind: 'bet', holder: 'alice-example', weight: 0.6, since_date: '2023-02-01' }]);
    got.afterEdit = await horizon('scan', '--json');
    got.otherSource = await horizon('scan', '--source-id', 'other', '--json');
    got.journal = await journal();
    got.journalSome = await journal([scan.ids[1]!, other.ids[0]!, drop.ids[0]! + 1000]);
    got.cleared = await horizon('clear', 'notes/h-scan', '--row', '2');
    got.clearedAgain = await horizon('clear', 'notes/h-scan', '--row', '2');
    await engine.deletePage('notes/h-drop');
    got.afterDelete = await journal();
    const json = (value: unknown) => ({ code: null, stdout: JSON.stringify(value, null, 2), stderr: '' });
    const proposal = (take: string, claim: string, date: string, basis: string, phrase: string, replaces: string | null = null) =>
      ({ take_id: take, claim, horizon_date: date, basis, phrase, replaces });
    const acme = proposal('acme', 'Acme-example will reach $5M ARR by the end of 2024', '2024-12-31', 'stated', 'by the end of 2024');
    const bluefin = proposal('bluefin', 'Bluefin-example will open a Berlin office within 18 months', '2024-08-01', 'stated_relative', 'within 18 months');
    const otherP = proposal('other', 'Other-example will ship by Q3 2025', '2025-09-30', 'stated', 'by Q3 2025');
    const dropP = proposal('drop', 'Drop-example will reach profit by March 2026', '2026-03-31', 'stated', 'by March 2026');
    expect(got).toEqual({
      preview: json({ applied: false, proposed: [acme, bluefin, otherP, dropP], written: 0, kept_owner: 0, unparsed: 1 }),
      journalBefore: [],
      applied: json({ applied: true, proposed: [acme, bluefin, otherP, dropP], written: 4, kept_owner: 0, unparsed: 1 }),
      again: { code: null, stderr: '', stdout: '0 stated horizon(s) to write. 0 owner horizon(s) kept, 1 take(s) state no single deadline.' },
      set: { code: null, stderr: '', stdout: 'Set the horizon of notes/h-scan#2 to 2025-06-30 (owner).' },
      badDate: { code: 1, stdout: '', stderr: 'horizon date "2025-02-30" is not a calendar day in YYYY-MM-DD form\n' },
      afterEdit: json({ applied: false, proposed: [proposal('acme', 'Acme-example will reach $5M ARR by the end of 2025', '2025-12-31', 'stated', 'by the end of 2025', '2024-12-31')], written: 0, kept_owner: 1, unparsed: 0 }),
      otherSource: json({ applied: false, proposed: [], written: 0, kept_owner: 0, unparsed: 0 }),
      journal: [['acme', '2024-12-31', 'stated', false], ['bluefin', '2024-08-01', 'stated_relative', true], ['cobalt', '2025-06-30', 'owner', true],
        ['drop', '2026-03-31', 'stated', true], ['other', '2025-09-30', 'stated', true]],
      journalSome: [['cobalt', '2025-06-30', 'owner', true], ['other', '2025-09-30', 'stated', true]],
      cleared: { code: null, stderr: '', stdout: 'Cleared the horizon of notes/h-scan#2.' },
      clearedAgain: { code: null, stderr: '', stdout: 'notes/h-scan#2 had no horizon.' },
      afterDelete: [['acme', '2024-12-31', 'stated', false], ['bluefin', '2024-08-01', 'stated_relative', true], ['other', '2025-09-30', 'stated', true]],
    });
    return got;
  });

  parityTest('the horizon members refuse a horizon for a missing take and read a missing take as null', {
    methods: ['putPage', 'addTakesBatch', 'findTakeId', 'readTakeClaim', 'upsertTakeHorizon', 'deleteTakeHorizon', 'listTakeHorizons', 'listHorizonScanRows'],
  }, async (engine) => {
    const { ids } = await datedTakes(engine, 'notes/h-member', ['Member-example will ship by 2027']);
    const missing = ids[0]! + 1000;
    const got = {
      claim: await engine.readTakeClaim(ids[0]!),
      missingClaim: await engine.readTakeClaim(missing),
      missingUpsert: await engine.upsertTakeHorizon({ takeId: missing, claimSha256: 'x', horizonDate: '2027-12-31', basis: 'owner' }).then(() => 'ok', (e: Error) => e.message),
      missingDelete: await engine.deleteTakeHorizon(missing),
      none: await engine.listTakeHorizons([missing]),
      // The scan reads every live take with no horizon as a row with null horizon fields; the id is left out (not stable across arms).
      scan: (await engine.listHorizonScanRows('default')).map(({ id: _id, ...rest }) => rest),
      otherSource: await engine.listHorizonScanRows('no-such-source'),
    };
    expect(got).toEqual({
      claim: 'Member-example will ship by 2027', missingClaim: null,
      missingUpsert: 'insert or update on table "take_horizons" violates foreign key constraint "take_horizons_take_id_fkey"',
      missingDelete: false, none: [],
      scan: [{ claim: 'Member-example will ship by 2027', since_date: '2023-02-01', basis: null, claim_sha256: null, horizon_date: null }],
      otherSource: [],
    });
    return got;
  });
});

describe('engine parity: the page grade_takes resolves a judged take on', () => {
  parityTest('readLiveTakePage finds the live page holding the claim at its row, in any source, and nothing else', {
    methods: ['putPage', 'addTakesBatch', 'findTakeId', 'softDeletePage', 'readLiveTakePage'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const live = await datedTakes(engine, 'notes/g-live', ['one', 'two']);
    const elsewhere = await datedTakes(engine, 'notes/g-other', ['one'], 'other');
    const gone = await datedTakes(engine, 'notes/g-gone', ['one']);
    await engine.softDeletePage('notes/g-gone');
    const at = (pageId: number, rowNum: number, claim: string) => engine.readLiveTakePage({ pageId, rowNum, claim });
    const got = {
      live: await at(live.pageId, 2, 'two'),
      otherSource: await at(elsewhere.pageId, 1, 'one'),
      changedClaim: await at(live.pageId, 1, 'two'),
      missingRow: await at(live.pageId, 3, 'two'),
      deleted: await at(gone.pageId, 1, 'one'),
      noPage: await at(gone.pageId + 1000, 1, 'one'),
    };
    expect(got).toEqual({
      live: { slug: 'notes/g-live', source_id: 'default' }, otherSource: { slug: 'notes/g-other', source_id: 'other' },
      changedClaim: null, missingRow: null, deleted: null, noPage: null,
    });
    return got;
  });
});

/** Fixture: `gbrain calibration <args>`, with its stdout writes and stderr captured. */
async function calibration(engine: BrainEngine, args: string[]) {
  const { runCalibration } = await import('../../src/commands/calibration.ts');
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await runCalibration(engine, args, {} as never);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout, stderr };
}

describe('engine parity: gbrain calibration --undo-wave', () => {
  parityTest('undo-wave counts a wave on a dry run, then reverts the same resolutions, verdicts, profiles and nudges', {
    methods: ['putPage', 'addTakesBatch', 'findTakeId', 'resolveTake', 'insertTakeGrade', 'insertCalibrationProfile', 'insertTakeNudge', 'listTakeNudges',
      'listWaveAppliedTakeIds', 'revertWaveTakeResolutions', 'unapplyWaveTakeGrades', 'purgeCalibrationProfilesByWave', 'purgeTakeNudgesByWave',
      'listTakes', 'listLatestTakeGrades'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const wave = 'v9.9.9.0';
    const old = 'v0.36.1.0';
    const { pageId, ids } = await datedTakes(engine, 'notes/w-takes', ['one by 2025', 'two by 2025', 'three by 2025', 'four by 2025']);
    const graded = 'gbrain:grade_takes';
    await engine.resolveTake(pageId, 1, { quality: 'correct', resolvedBy: graded });
    await engine.resolveTake(pageId, 2, { quality: 'incorrect', resolvedBy: graded });
    // Row 3 was graded by the wave, but a manual resolve overrode it: undo-wave leaves it.
    await engine.resolveTake(pageId, 3, { quality: 'partial', resolvedBy: 'cli:alice-example' });
    const grade = (row: number, waveVersion: string, applied: boolean, gradedAt: string) => engine.insertTakeGrade({
      takeId: ids[row - 1]!, promptVersion: 'p1', judgeModelId: 'j1', evidenceSignature: `sig-${row}-${waveVersion}`,
      verdict: 'correct', confidence: 0.9, applied, gradedAt, waveVersion,
    });
    await grade(1, old, true, '2026-01-01T00:00:00Z');
    await grade(1, wave, true, '2026-02-01T00:00:00Z');
    await grade(2, wave, true, '2026-02-01T00:00:00Z');
    await grade(3, wave, true, '2026-02-01T00:00:00Z');
    await grade(4, wave, false, '2026-02-01T00:00:00Z');
    const profile = (waveVersion: string) => engine.insertCalibrationProfile({
      sourceId: 'default', holder: 'alice-example', totalResolved: 3, brier: 0.2, accuracy: 0.5, partialRate: 0.1, gradeCompletion: 1,
      domainScorecards: {}, patternStatements: [], voiceGatePassed: true, voiceGateAttempts: 1, activeBiasTags: [], modelId: 'm1', waveVersion,
    });
    await profile(wave);
    await profile(old);
    const nudge = (row: number, waveVersion: string, sourceId = 'default') => engine.insertTakeNudge({ sourceId, takeId: ids[row - 1]!, nudgePattern: 'stale-take', waveVersion });
    await nudge(1, wave);
    await nudge(2, wave, 'other');
    await nudge(1, old);
    const badNudge = await engine.insertTakeNudge({ sourceId: 'default', nudgePattern: 'stale-take', waveVersion: wave }).then(() => 'ok', (e: Error) => e.message);
    // listTakeNudges, insertTakeNudge's confirming read: a source's rows by id, narrowed by target, pattern and wave; the take
    // ids are shown as the row of the take, since each engine numbers its takes itself.
    const listed = async (f: Parameters<typeof engine.listTakeNudges>[0]) => (await engine.listTakeNudges(f)).map(n =>
      [n.id > 0, n.source_id, ids.indexOf(n.take_id ?? -1) + 1, n.proposal_id, n.nudge_pattern, n.channel, n.wave_version, !Number.isNaN(Date.parse(n.fired_at))]);
    const listedNudges = {
      source: await listed({ sourceId: 'default' }),
      byTake: await listed({ sourceId: 'default', takeId: ids[0]! }),
      byWave: await listed({ sourceId: 'default', waveVersion: wave }),
      byPattern: await listed({ sourceId: 'other', nudgePattern: 'stale-take' }),
      none: await listed({ sourceId: 'default', nudgePattern: 'held' }),
      noSource: await listed({ sourceId: 'missing' }),
    };
    const undo = async (...args: string[]) => {
      const run = await calibration(engine, ['--undo-wave', ...args]);
      return { ...run, stdout: args.includes('--json') ? JSON.parse(run.stdout) : run.stdout };
    };
    const state = async () => ({
      takes: (await engine.listTakes({ page_id: pageId })).map(t => [t.row_num, t.resolved_quality, t.resolved_by, t.resolved_at !== null]).sort((a, b) => Number(a[0]) - Number(b[0])),
      grades: (await engine.listLatestTakeGrades({ verdict: null, minConfidence: null, applied: null, limit: 10 })).map(g => [g.row_num, g.applied]).sort((a, b) => Number(a[0]) - Number(b[0])),
    });
    const got = {
      badNudge,
      listedNudges,
      dryRun: await undo(wave, '--dry-run', '--json'),
      afterDryRun: await state(),
      real: await undo(wave),
      after: await state(),
      again: await undo(wave, '--json'),
      oldWave: await undo(old, '--dry-run', '--json'),
    };
    const counts = (dryRun: boolean, resolutions: number, profiles: number, nudges: number, grades: number, waveVersion = wave) => ({
      wave_version: waveVersion, dry_run: dryRun, resolutions_reverted: resolutions, profiles_deleted: profiles, nudges_purged: nudges,
      grade_cache_unapplied: grades, gstack_scrub_attempted: false, warnings: [],
    });
    const stderr = (dry: boolean, waveVersion = wave) => `[calibration] ${dry ? '[dry-run] ' : ''}reversing wave ${waveVersion}...\n`;
    const before = {
      takes: [[1, 'correct', graded, true], [2, 'incorrect', graded, true], [3, 'partial', 'cli:alice-example', true], [4, null, null, false]],
      grades: [[1, true], [2, true], [3, true], [4, false]],
    };
    expect(got).toEqual({
      badNudge: 'new row for relation "take_nudge_log" violates check constraint "take_nudge_log_target_xor"',
      listedNudges: {
        source: [[true, 'default', 1, null, 'stale-take', 'stderr', wave, true], [true, 'default', 1, null, 'stale-take', 'stderr', old, true]],
        byTake: [[true, 'default', 1, null, 'stale-take', 'stderr', wave, true], [true, 'default', 1, null, 'stale-take', 'stderr', old, true]],
        byWave: [[true, 'default', 1, null, 'stale-take', 'stderr', wave, true]],
        byPattern: [[true, 'other', 2, null, 'stale-take', 'stderr', wave, true]],
        none: [],
        noSource: [],
      },
      dryRun: { stdout: counts(true, 2, 1, 2, 3), stderr: stderr(true) },
      afterDryRun: before,
      real: { stderr: stderr(false), stdout: 'reverted:\n  2 take resolutions\n  1 calibration profile(s)\n  2 nudge log row(s)\n  3 grade-cache rows marked unapplied\n' },
      after: {
        takes: [[1, null, null, false], [2, null, null, false], [3, 'partial', 'cli:alice-example', true], [4, null, null, false]],
        grades: [[1, false], [2, false], [3, false], [4, false]],
      },
      again: { stdout: counts(false, 0, 0, 0, 0), stderr: stderr(false) },
      oldWave: { stdout: counts(true, 0, 1, 1, 1, old), stderr: stderr(true, old) },
    });
    return got;
  });
});
