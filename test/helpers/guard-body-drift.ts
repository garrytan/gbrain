/**
 * #7776 fixtures: install a "newer" body for a schema function (its live definition plus a marker comment, the shape a
 * newer gbrain's migration leaves) and read a body back, on either engine; the same for links_link_source_check, which
 * runMigrations' drift repair rewrites, and a forced schema run of apply-migrations in a child process.
 */
import { resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';

const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');

export const NEWER_BODY_MARKER = '-- body installed by a newer gbrain (#7776 fixture)';

/** The live body (prosrc) of a public function, or null when it is not installed. */
export async function functionBody(engine: BrainEngine, name: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ prosrc: string }>(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
  return rows[0]?.prosrc ?? null;
}

/** Re-creates `name` with its current definition plus NEWER_BODY_MARKER before the closing quote. */
export async function installNewerBody(engine: BrainEngine, name: string): Promise<void> {
  const [row] = await engine.executeRaw<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
  if (!row) throw new Error(`function ${name} is not installed`);
  const end = row.def.lastIndexOf('$function$');
  await engine.runMigration(0, `${row.def.slice(0, end)}${NEWER_BODY_MARKER}\n${row.def.slice(end)}`);
}

const NEWER_LINK_SOURCE_CHECK = 'CHECK (link_source IS NULL OR char_length(link_source) <= 128)';

/** Re-creates links_link_source_check in a shape a newer gbrain could leave (one the v114 drift repair would rewrite). */
export async function installNewerLinkSourceCheck(engine: BrainEngine): Promise<void> {
  await engine.runMigration(0, `ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
    ALTER TABLE links ADD CONSTRAINT links_link_source_check ${NEWER_LINK_SOURCE_CHECK};`);
}

export async function linkSourceCheckDef(engine: BrainEngine): Promise<string | null> {
  const rows = await engine.executeRaw<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass('links') AND conname = 'links_link_source_check'`);
  return rows[0]?.def ?? null;
}

/** Runs \`gbrain apply-migrations --force-schema --json\` in a child against the brain configured under \`home\`. */
export async function forceSchemaRun(home: string): Promise<{ exitCode: number; doc: { code?: string; error?: string } | null; out: string }> {
  const child = Bun.spawn([process.execPath, '--no-env-file', CLI, 'apply-migrations', '--force-schema', '--json'], {
    cwd: home, env: { HOME: home, GBRAIN_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', GBRAIN_SKIP_REFERENCE_SWEEP: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const start = stdout.indexOf('{');
  let doc: { code?: string; error?: string } | null = null;
  try { doc = start >= 0 ? JSON.parse(stdout.slice(start)) : null; } catch { doc = null; }
  return { exitCode, doc, out: stderr + stdout };
}
