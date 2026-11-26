/**
 * Outside small-fix wave 1E: one regression per outside report whose fix is a message, a parser or a pattern.
 * Each case failed on master before its fix (#10307, #10275, #10103, #10040, #10039, #10351, #9868).
 */
import { describe, expect, test } from 'bun:test';
import { collectSchemaPack } from '../src/core/advisor/collect-schema-pack.ts';
import { SCHEMA_SUBCOMMANDS } from '../src/cli/subcommands.ts';
import { factBulkDatesCheck } from '../src/commands/doctor/checks/fact-bulk-dates.ts';
import { packDeclaresPageType } from '../src/core/schema-pack/write-vocabulary.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';
import { migrationHostWorkCheck } from '../src/commands/doctor/checks/migration-host-work.ts';
import { unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { assessContentSanity } from '../src/core/content-sanity.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';

describe('#10307 schema-pack advisor', () => {
  test('an unresolved pack suggests a schema subcommand the router accepts', async () => {
    const engine = { getConfig: async (k: string) => (k === 'schema_pack' ? 'missing-pack-example' : null) };
    const findings = await collectSchemaPack.collect({ engine, remote: false, config: {}, now: new Date(0) } as never);
    const argv = findings.find(f => f.id === 'schema_pack_unresolved')?.fix?.command_argv ?? [];
    expect(argv).toEqual(['gbrain', 'schema', 'list']);
    expect(SCHEMA_SUBCOMMANDS as readonly string[]).toContain(argv[2]);
  });
});

describe('#10275 fact_bulk_dates', () => {
  test('the diagnosis does not claim same-day dates are load dates', async () => {
    const day = { source_id: 'events', day: '2025-04-10', facts: 200, entities: 20, source_facts: 200, top_sources: [], dated_claims: 0 };
    const engine = { executeRaw: async () => [day] } as unknown as BrainEngine;
    const check = await factBulkDatesCheck(engine, ['events']);
    expect(check.status).toBe('warn');
    expect(check.message).not.toContain('These dates record when the facts were loaded, not when they happened');
    expect(check.message).toContain('can also be events that really happened that day');
    expect(check.message).toContain('0 state one earlier date in the claim');
  });
});

describe('#10103 write-time page type check', () => {
  test('a declared alias counts as declared, as schema lint reads it', () => {
    const pack = { manifest: { name: 'fake-pack', page_types: [{ name: 'company', aliases: ['org'] }, { name: 'person', aliases: [] }], link_types: [] } } as unknown as ResolvedPack;
    expect(packDeclaresPageType(pack, 'company')).toBe(true);
    expect(packDeclaresPageType(pack, 'org')).toBe(true);
    expect(packDeclaresPageType(pack, 'widget')).toBe(false);
  });
});

describe('#10040 minions_migration host work', () => {
  test('the warning says the preview never clears it and names the opt-out and the real run', () => {
    const history = new Map<string, CompletedMigrationEntry[]>([['0.53.0', [{ version: '0.53.0', status: 'complete', apply_migrations_pending: true } as CompletedMigrationEntry]]]);
    const check = migrationHostWorkCheck(history, new Set(), new Set(['0.53.0']))!;
    expect(check.status).toBe('warn');
    expect(check.message).toContain('it records nothing, so it never clears this warning');
    expect(check.message).toContain('gbrain sources shared-skills <source> off');
    expect(check.message).toContain('the real run records the new state and clears this warning');
    expect(check.fix!.argv).toEqual(['gbrain', 'apply-migrations', '--migration', '0.53.0', '--dry-run', '--json']);
  });
});

describe('#10039 unlinked_facts conversation hint', () => {
  test('the message names the real relink command, not the dry run', () => {
    const verdict = unlinkedFactsVerdict({
      sources: 1,
      window: { active: 60, unlinked: 40, fence_owned: 0, conversation: 40, capped: false },
      conversation: { source_id: 'default', fix: 'relink', pages: 2, slugs: ['meetings/a-example', 'meetings/b-example'] },
      new_7d: { facts: 60, unlinked: 40, no_subject: 0, conversation_unresolved: 0 },
      no_subject: 0, origins: [{ origin: 'conversation', unlinked: 40 }], inferred_7d: { page: 0, mention: 0 }, relinked_7d: {},
    });
    const real = 'gbrain facts relink --conversation --source default --slugs meetings/a-example,meetings/b-example';
    expect(verdict.fix!.argv!.join(' ')).toBe(real);
    expect(verdict.message).toContain(`link them for free: ${real} (add --dry-run to preview`);
    expect(verdict.message).not.toContain(`${real} --dry-run`);
    expect(verdict.message).toContain('only the real run moves this warning');
  });
});

describe('#10351 interrupted PostgreSQL data-file reads', () => {
  const pg = (message: string) => Object.assign(new Error(message), { code: 'XX000' });
  const interrupted = [
    'could not open file "base/42/83_fsm": Interrupted system call',
    'could not read block 3 in file "global/pg_filenode.map": Interrupted system call',
    'could not read blocks 3..4 in file "base/42/83": Interrupted system call',
    'could not open file "pg_tblspc/42/64/83" (target block 3): Interrupted system call',
  ];
  test.each(interrupted)('%s is storage_interrupted, not storage_corrupt', message => {
    const d = classifyPgAccessError(pg(message));
    expect(d.reason).toBe('storage_interrupted');
    expect(d.transient).toBe(false);
    expect(d.fix).toBeUndefined();
    expect(d.remediation).toContain('not a sign of damaged rows');
    const out = JSON.parse(renderCliError(pg(message), { json: true, command: 'jobs submit', tty: false }).stdout!);
    expect(out).toMatchObject({ code: 'database_error', reason: 'storage_interrupted' });
    expect(out.suggestion).toContain('original job or write receipt');
    // #10408: a host storage fault goes to the host admin; db-repair only probes the connection and reports healthy.
    expect(out.fix).toMatchObject({ actor: 'host_admin', next: 'report' });
    expect(out.fix.argv).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('db-repair');
  });
  test('a real damaged read and an unrelated interrupted call keep their classes', () => {
    expect(classifyPgAccessError(pg('could not read block 3 in file "base/42/83": read only 0 of 8192 bytes')).reason).toBe('storage_corrupt');
    expect(classifyPgAccessError(pg('unexpected chunk number 6 for toast value 42')).reason).toBe('storage_corrupt');
    expect(classifyPgAccessError(pg('could not write to log file: Interrupted system call')).reason).toBe('unknown');
  });
});

describe('#9868 cloudflare_attention_required', () => {
  const junk = (body: string, title = 'Login outage notes') =>
    assessContentSanity({ compiled_truth: body, timeline: '', title }).junk_pattern_matches;
  test('prose quoting a Cloudflare 403 error line is not junk', () => {
    expect(junk('The CLI failed with: API Error: 403 Attention Required! | Cloudflare\n')).not.toContain('cloudflare_attention_required');
  });
  test('the interstitial title, heading and HTML title still match', () => {
    expect(junk('Please wait.', 'Attention Required! | Cloudflare')).toContain('cloudflare_attention_required');
    expect(junk('# Attention Required! | Cloudflare\nPlease enable cookies.')).toContain('cloudflare_attention_required');
    expect(junk('<html><head><title>Attention Required! | Cloudflare</title></head>')).toContain('cloudflare_attention_required');
    expect(junk('Intro\nAttention Required! | Cloudflare\nPlease enable cookies.')).toContain('cloudflare_attention_required');
  });
});
