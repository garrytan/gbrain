/**
 * Per-surface source-text loaders for structural guards (refactor wave 1, A10).
 *
 * A "surface" is one god file plus the modules it is being decomposed into.
 * Guards that read a surface's source must keep seeing their target after a
 * peel moves it, or they rot into permanently-green no-ops. Two loaders, two
 * guard classes (same split as doctor-source.ts, which now delegates here):
 *
 * - surfaceSource(surface): the whole surface, façade first, then every other
 *   listed file, then every file under the surface's new module dirs (sorted),
 *   joined with a file-boundary marker. For CONTAINMENT assertions only
 *   (toContain / not.toContain / toMatch with no ordering or cross-line span).
 * - surfaceFileSource(surface, rel): exactly one named file of the surface, for
 *   POSITIONAL assertions (indexOf ordering, slice windows, multi-line regex
 *   spans, line counts). Concatenation would let those match across files,
 *   which is weaker than the guard intends, so the caller names the file that
 *   holds the code; a file outside the surface throws.
 *
 * Today every surface except doctor resolves to its single current file (the
 * module dirs below do not exist yet), so re-pointing a guard here is a no-op.
 * A lane that moves code out of a façade adds the destination: a new dir is
 * globbed automatically; a module in an EXISTING dir or flat file set (e.g.
 * src/core/minions/handlers/, src/commands/serve-http-oauth.ts) must be added
 * to `files` explicitly in the same commit, because globbing an existing dir
 * would widen today's assertions instead of preserving them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

interface SurfaceDef {
  /** Repo-relative files, façade first. Missing files are skipped (planned modules). */
  files: string[];
  /** Repo-relative module dirs created by the decomposition; every .ts file below is included. */
  dirs: string[];
}

export const SOURCE_SURFACES = {
  sync: { files: ['src/commands/sync.ts'], dirs: ['src/commands/sync'] },
  cli: { files: ['src/cli.ts'], dirs: ['src/cli'] },
  'serve-http': {
    files: [
      'src/commands/serve-http.ts',
      'src/commands/serve-http-admin-api.ts',
      'src/commands/serve-http-mcp.ts',
      'src/commands/serve-http-spa.ts',
      'src/commands/serve-http-oauth.ts',
      'src/commands/serve-http-metrics.ts',
      'src/commands/serve-http-webhooks.ts',
    ],
    dirs: [],
  },
  jobs: {
    files: [
      'src/commands/jobs.ts',
      // W4 jobs: registerBuiltinHandlers' inline handler bodies, moved into an existing dir.
      'src/core/minions/handlers/autopilot-cycle.ts',
      'src/core/minions/handlers/autopilot-global-maintenance.ts',
      'src/core/minions/handlers/backlinks.ts',
      'src/core/minions/handlers/chronicle-extract.ts',
      'src/core/minions/handlers/cycle-phase.ts',
      'src/core/minions/handlers/embed-catch-up.ts',
      'src/core/minions/handlers/embed.ts',
      'src/core/minions/handlers/enrich.ts',
      'src/core/minions/handlers/extract-atoms-drain.ts',
      'src/core/minions/handlers/extract-conversation-facts.ts',
      'src/core/minions/handlers/extract-ner.ts',
      'src/core/minions/handlers/extract-takes-from-pages.ts',
      'src/core/minions/handlers/extract-timeline-from-meetings.ts',
      'src/core/minions/handlers/extract.ts',
      'src/core/minions/handlers/facts-absorb.ts',
      'src/core/minions/handlers/import.ts',
      'src/core/minions/handlers/integrity-auto.ts',
      'src/core/minions/handlers/integrity.ts',
      'src/core/minions/handlers/job-pull.ts',
      'src/core/minions/handlers/lint-fix.ts',
      'src/core/minions/handlers/lint.ts',
      'src/core/minions/handlers/loops-extract.ts',
      'src/core/minions/handlers/orphans.ts',
      'src/core/minions/handlers/purge.ts',
      'src/core/minions/handlers/reindex.ts',
      'src/core/minions/handlers/repair-jsonb.ts',
      'src/core/minions/handlers/sync-retry-failed.ts',
      'src/core/minions/handlers/sync.ts',
      'src/core/minions/handlers/unify-types.ts',
    ],
    dirs: ['src/commands/jobs'],
  },
  hybrid: { files: ['src/core/search/hybrid.ts'], dirs: ['src/core/search/hybrid'] },
  autopilot: {
    files: [
      'src/commands/autopilot.ts',
      // W4 autopilot: daemon modules peeled out of runAutopilot into the flat autopilot-*.ts set.
      'src/commands/autopilot-daemon.ts',
      'src/commands/autopilot-dispatch.ts',
      'src/commands/autopilot-probes.ts',
    ],
    dirs: ['src/commands/autopilot'],
  },
  migrate: { files: ['src/core/migrate.ts'], dirs: ['src/core/schema-migrations'] },
  'pglite-engine': { files: ['src/core/pglite-engine.ts'], dirs: ['src/core/engine-sql'] },
  'postgres-engine': { files: ['src/core/postgres-engine.ts', 'src/core/search/vector-statement.ts'], dirs: ['src/core/engine-sql'] },
  doctor: { files: ['src/commands/doctor.ts'], dirs: ['src/commands/doctor'] },
} satisfies Record<string, SurfaceDef>;

export type SourceSurface = keyof typeof SOURCE_SURFACES;

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Absolute paths of every file on the surface: listed files in order, then sorted module-dir files. */
export function surfaceFiles(surface: SourceSurface): string[] {
  const def: SurfaceDef = SOURCE_SURFACES[surface];
  const listed = def.files.map((f) => join(REPO_ROOT, f)).filter((f) => existsSync(f));
  const seen = new Set(listed);
  const moduleFiles = def.dirs.flatMap((d) => listTs(join(REPO_ROOT, d))).filter((f) => !seen.has(f));
  return [...listed, ...moduleFiles];
}

/** A separator no plausible TS source contains, so cross-file matches are visible. */
export function surfaceFileBoundary(surface: SourceSurface): string {
  return `\n /* __${surface}-source-file-boundary__ */ \n`;
}

/** Concatenated surface for CONTAINMENT assertions. */
export function surfaceSource(surface: SourceSurface): string {
  return surfaceFiles(surface)
    // test-reads-source-ok[structural]: A10 containment loader; guards assert a construct exists somewhere on the surface.
    .map((f) => readFileSync(f, 'utf-8'))
    .join(surfaceFileBoundary(surface));
}

/**
 * One named file of the surface for POSITIONAL assertions.
 * @param rel repo-relative path, e.g. 'src/commands/sync.ts'
 */
export function surfaceFileSource(surface: SourceSurface, rel: string): string {
  const abs = join(REPO_ROOT, rel);
  if (!surfaceFiles(surface).includes(abs)) {
    const members = surfaceFiles(surface).map((f) => relative(REPO_ROOT, f));
    throw new Error(`surfaceFileSource: ${rel} is not on the ${surface} surface (${members.join(', ')})`);
  }
  // test-reads-source-ok[structural]: A10 positional loader; the caller names the single file that holds the code.
  return readFileSync(abs, 'utf-8');
}
