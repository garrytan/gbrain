/**
 * `gbrain guests` (GBRA-504): guest sources, the database-only, federated sources an outside-guest broker saves notes
 * into. `init` sets one up; `promote` keeps a guest note as an owner page (op promote_guest_note); `grant-owner-clients`
 * adds the guest source to the read list of each credential bound to the brain owner. init and grant-owner-clients
 * preview by default and apply only with --yes. Trusted local CLI only. Guide: docs/guides/guest-notes.md.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { GUEST_TRUST_CEILING, GUEST_WRITER_FORMAT, initGuestSource, isGuestWriter, planGuestSource } from '../core/guests/sources.ts';
import { grantOwnerCredentials, ownerCredentials } from '../core/guests/owner-credentials.ts';
import { exitCliError } from '../cli/cli-error.ts';
import { loadConfig } from '../core/config.ts';

export const GUESTS_USAGE = `Usage: gbrain guests init [--source <id>] [--writer ${GUEST_WRITER_FORMAT}]... [--yes]
       gbrain guests promote <guest-slug> [--to <slug>] [--source <id>] [--guest-source <id>] [--json]
       gbrain guests grant-owner-clients [--source <id>] [--yes] [--json]

  init sets up a guest source for notes saved by outside guests: database-only (no local
  path or repository), federated, pages capped at ${GUEST_TRUST_CEILING}, and writable
  only by the listed writers. The source defaults to "guests". Without --yes it
  prints what it would do and writes nothing. Change writers later with
  gbrain sources writers <id>.

  promote keeps a guest note as your own page in --source (your default source when
  omitted), at --to (the note's slug when omitted), with promoted_from naming the note.
  The guest note stays as it is, and its writer can no longer delete it.

  grant-owner-clients lists each credential bound to the brain owner that cannot read
  the guest source (--source, default "guests"), and with --yes adds it to their read
  lists, keeping every source they already read.`;

function usageError(message: string): never {
  console.error(message);
  console.error(GUESTS_USAGE);
  process.exit(2);
}

export async function runGuests(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) { console.log(GUESTS_USAGE); return; }
  if (sub === 'init') return runInit(engine, rest);
  if (sub === 'promote') return runPromote(engine, rest);
  if (sub === 'grant-owner-clients') return runGrantOwnerClients(engine, rest);
  usageError(`Unknown guests subcommand: ${sub}`);
}

/** The value flags and boolean flags of one subcommand, plus its positionals. */
function parseFlags(rest: string[], values: readonly string[], booleans: readonly string[]): { flags: Record<string, string[]>; on: Set<string>; positional: string[] } {
  const flags: Record<string, string[]> = {}, on = new Set<string>(), positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (booleans.includes(arg)) on.add(arg);
    else if (values.includes(arg) && rest[i + 1] !== undefined) (flags[arg] ??= []).push(rest[++i]!);
    else if (!arg.startsWith('-')) positional.push(arg);
    else usageError(`Unknown or incomplete argument: ${arg}`);
  }
  return { flags, on, positional };
}

function checkedSource(id: string): string {
  if (!isValidSourceId(id)) {
    console.error(`Invalid source id "${id}". Must be 1-32 lowercase alnum chars with optional interior hyphens.`);
    process.exit(2);
  }
  return id;
}

async function runInit(engine: BrainEngine, rest: string[]): Promise<void> {
  const { flags, on, positional } = parseFlags(rest, ['--source', '--writer'], ['--yes']);
  if (positional.length) usageError(`Unknown or incomplete argument: ${positional[0]}`);
  const sourceId = checkedSource(flags['--source']?.at(-1) ?? 'guests');
  const writers = flags['--writer'] ?? [];
  const yes = on.has('--yes');
  const malformed = writers.filter(w => !isGuestWriter(w));
  if (malformed.length > 0) {
    console.error(`Not a writer principal: ${malformed.join(', ')}. Name each writer as ${GUEST_WRITER_FORMAT}, for example oauth_client:<client id>.`);
    process.exit(2);
  }

  const plan = await planGuestSource(engine, sourceId, writers);
  if (plan.localPath) {
    console.error(`Source "${sourceId}" has a local path (${plan.localPath}). A guest source is database-only, so gbrain will not make this one a guest source. Pick another name with --source.`);
    process.exit(2);
  }
  const writerLine = (list: readonly string[]) => list.length > 0 ? list.join(', ')
    : `none yet: nobody can save notes there until you add one (gbrain sources writers ${sourceId} --add ${GUEST_WRITER_FORMAT})`;
  if (!yes) {
    console.log('Preview: gbrain guests init (nothing written; run again with --yes to apply)');
    console.log(`  Source "${sourceId}": ${!plan.exists ? 'will be created, database-only (no local path) and federated'
      : plan.guest ? 'is already a guest source' : 'exists with no local path; it becomes a guest source and is federated'}.`);
    console.log(`  Trust ceiling: ${GUEST_TRUST_CEILING} (no page there is ever stored above it).`);
    console.log(`  Writers: ${writerLine(plan.writers)}`);
    return;
  }
  const guest = await initGuestSource(engine, sourceId, writers);
  console.log(`Source "${sourceId}" is ${plan.exists ? 'now' : 'created as'} a guest source: database-only, federated, trust ceiling ${guest.trust_ceiling}.`);
  console.log(`  Writers: ${writerLine(guest.writers)}`);
}

async function runPromote(engine: BrainEngine, rest: string[]): Promise<void> {
  const { flags, on, positional } = parseFlags(rest, ['--to', '--source', '--guest-source'], ['--json']);
  if (positional.length !== 1) usageError('Name exactly one guest note slug.');
  const explicit = flags['--source']?.at(-1);
  const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
  const sourceId = (await resolveSourceWithTier(engine, explicit ? checkedSource(explicit) : null)).source_id;
  const { promoteGuestNote } = await import('../core/guests/promote.ts');
  const params = { slug: positional[0]!, source_id: sourceId, ...(flags['--to'] ? { to: flags['--to'].at(-1) } : {}),
    ...(flags['--guest-source'] ? { guest_source: flags['--guest-source'].at(-1) } : {}) };
  const ctx = { engine, config: loadConfig() || { engine: 'pglite' as const }, remote: false as const, dryRun: false, sourceId,
    logger: { info: (m: string) => process.stderr.write(`[info] ${m}\n`), warn: (m: string) => process.stderr.write(`[warn] ${m}\n`), error: (m: string) => process.stderr.write(`[error] ${m}\n`) } };
  let result: Record<string, any>;
  try { result = await promoteGuestNote(ctx, params) as Record<string, any>; }
  catch (e) { exitCliError(e, 'guests'); }
  if (on.has('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  const page = `${result.page.source_id}:${result.page.slug}`;
  console.log(result.status === 'already_promoted' ? `Guest note ${result.guest.source_id}:${result.guest.slug} is already kept as ${page}; nothing written.`
    : `Kept guest note ${result.guest.source_id}:${result.guest.slug} as ${page}. The guest note is unchanged and reads promoted: true.`);
}

async function runGrantOwnerClients(engine: BrainEngine, rest: string[]): Promise<void> {
  const { flags, on, positional } = parseFlags(rest, ['--source'], ['--yes', '--json']);
  if (positional.length) usageError(`Unknown or incomplete argument: ${positional[0]}`);
  const sourceId = checkedSource(flags['--source']?.at(-1) ?? 'guests');
  const [guest] = await engine.executeRaw('SELECT 1 FROM guest_sources WHERE source_id = $1', [sourceId]);
  if (!guest) {
    console.error(`Source "${sourceId}" is not a guest source. Set one up with: gbrain guests init --source ${sourceId}`);
    process.exit(2);
  }
  const { owner, credentials } = await ownerCredentials(engine, sourceId);
  const missing = credentials.filter(c => !c.readsGuest);
  const outcomes = on.has('--yes') ? await grantOwnerCredentials(engine, sourceId, missing) : null;
  if (on.has('--json')) { console.log(JSON.stringify({ source: sourceId, owner, credentials: missing, ...(outcomes ? { outcomes } : {}) }, null, 2)); return; }
  if (!owner) { console.log('No brain owner is set (gbrain access owner set <member>), so no credential reads as the owner.'); return; }
  if (!missing.length) { console.log(`Every credential bound to ${owner} already reads "${sourceId}".`); return; }
  if (!outcomes) {
    console.log(`Preview: gbrain guests grant-owner-clients (nothing written; run again with --yes to apply)`);
    for (const c of missing) {
      console.log(`  ${c.kind} ${c.name} (${c.id}): ${c.after ? `${c.readSources.join(', ')} -> ${c.after.join(', ')}` : 'left alone: it has no source grant to add to'}`);
    }
    return;
  }
  for (const o of outcomes) {
    console.log(`  ${o.kind} ${o.name} (${o.id}): ${o.outcome === 'granted' ? `now reads "${sourceId}"` : o.outcome === 'conflict'
      ? 'not changed: its grant changed since this preview; run the command again' : `not changed: ${o.detail}`}`);
  }
  if (outcomes.some(o => o.outcome === 'conflict')) process.exitCode = 1;
}
