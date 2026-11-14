/**
 * `gbrain guests init` (GBRA-504): sets up a guest source, the database-only,
 * federated source an outside-guest broker saves notes into. Previews by
 * default; `--yes` applies. Trusted local CLI only. Guide: docs/guides/guest-notes.md.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { GUEST_TRUST_CEILING, GUEST_WRITER_FORMAT, initGuestSource, isGuestWriter, planGuestSource } from '../core/guests/sources.ts';

export const GUESTS_USAGE = `Usage: gbrain guests init [--source <id>] [--writer ${GUEST_WRITER_FORMAT}]... [--yes]

  Sets up a guest source for notes saved by outside guests: database-only (no local
  path or repository), federated, pages capped at ${GUEST_TRUST_CEILING}, and writable
  only by the listed writers. The source defaults to "guests". Without --yes it
  prints what it would do and writes nothing. Change writers later with
  gbrain sources writers <id>.`;

export async function runGuests(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') { console.log(GUESTS_USAGE); return; }
  if (sub !== 'init') {
    console.error(`Unknown guests subcommand: ${sub}`);
    console.error(GUESTS_USAGE);
    process.exit(2);
  }
  let sourceId = 'guests';
  const writers: string[] = [];
  let yes = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--yes') yes = true;
    else if ((arg === '--source' || arg === '--writer') && rest[i + 1] !== undefined) {
      if (arg === '--source') sourceId = rest[++i]!; else writers.push(rest[++i]!);
    } else if (arg === '--help' || arg === '-h') { console.log(GUESTS_USAGE); return; }
    else {
      console.error(`Unknown or incomplete argument: ${arg}`);
      console.error(GUESTS_USAGE);
      process.exit(2);
    }
  }
  if (!isValidSourceId(sourceId)) {
    console.error(`Invalid source id "${sourceId}". Must be 1-32 lowercase alnum chars with optional interior hyphens.`);
    process.exit(2);
  }
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
