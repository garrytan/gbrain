/** Command-line parsing for run.ts (no dependencies). */
export interface Args {
  engine: 'pglite' | 'postgres';
  corpus: string;
  scale: string;
  out: string;
  databaseUrl?: string;
  dataDir: string;
  home: string;
  pgDataDir: string;
  only?: string[];
  quick: boolean;
  hnsw: 'inline' | 'deferred' | 'skip';
  importWorkers: number;
  poolMax: number;
  createDb: boolean;
  fresh: boolean;
  limitPages?: number;
  maxSeconds: number;
}

export const USAGE = `usage: bun rust/bench/baseline/run.ts --engine pglite|postgres --corpus <dir> --scale <10k|200k> --out <result.json> [options]

  --database-url <url>   postgres only: connection string of the benchmark database
  --create-db            postgres only: create the database if missing (comment-marked; --fresh may drop only such a database)
  --data-dir <dir>       pglite only: data directory (default <scratch>/pglite-<scale>)
  --scratch <dir>        scratch directory for GBRAIN_HOME and the default data dir (default /var/tmp/gbrain-bakeoff)
  --fresh                start from an empty store (removes a store this runner created; refuses anything else)
  --only a,b,c           run only these metrics against an existing store
  --hnsw inline|deferred|skip   how the HNSW index meets the import (default inline = gbrain's real behavior)
  --import-workers <n>   concurrent import transactions (default 1)
  --pool-max <n>         postgres pool size (default 20; gbrain's own default is 10)
  --pg-data-dir <dir>    postgres cluster dir, for server memory and WAL size (default /var/tmp/w1/pg16)
  --limit-pages <n>      use only the first n corpus pages
  --max-seconds <n>      cap per single-client metric (default 120)
  --quick                smoke run: 500 pages, short windows`;

export function parseArgs(argv: string[], metricNames: string[]): Args {
  const flags = new Map<string, string | true>();
  const valued = new Set(['engine', 'corpus', 'scale', 'out', 'database-url', 'data-dir', 'scratch', 'only', 'hnsw', 'import-workers', 'pool-max', 'pg-data-dir', 'limit-pages', 'max-seconds']);
  const boolean = new Set(['quick', 'fresh', 'create-db', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (boolean.has(name)) flags.set(name, true);
    else if (valued.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) fail(`--${name} needs a value`);
      flags.set(name, value);
    } else fail(`unknown flag --${name}`);
  }
  if (flags.has('help')) { console.log(USAGE); process.exit(0); }
  const str = (n: string) => flags.get(n) as string | undefined;
  const need = (n: string) => str(n) ?? fail(`--${n} is required`);
  const int = (n: string, d: number) => {
    const v = str(n);
    if (v === undefined) return d;
    const x = Number(v);
    if (!Number.isInteger(x) || x <= 0) fail(`--${n} must be a positive integer`);
    return x;
  };
  const engine = need('engine');
  if (engine !== 'pglite' && engine !== 'postgres') fail('--engine must be pglite or postgres');
  const hnsw = str('hnsw') ?? 'inline';
  if (hnsw !== 'inline' && hnsw !== 'deferred' && hnsw !== 'skip') fail('--hnsw must be inline, deferred or skip');
  const scale = need('scale');
  const scratch = str('scratch') ?? '/var/tmp/gbrain-bakeoff';
  const only = str('only')?.split(',').map(s => s.trim()).filter(Boolean);
  if (only) for (const n of only) if (!metricNames.includes(n)) fail(`unknown metric ${n}; known: ${metricNames.join(', ')}`);
  const quick = flags.has('quick');
  const limitPages = str('limit-pages') !== undefined ? int('limit-pages', 0) : quick ? 500 : undefined;
  if (engine === 'postgres' && !str('database-url')) fail('--database-url is required for postgres');
  if (engine === 'pglite' && (flags.has('create-db') || str('database-url'))) fail('--database-url and --create-db are for postgres');
  return {
    engine, corpus: need('corpus'), scale, out: need('out'), databaseUrl: str('database-url'),
    dataDir: str('data-dir') ?? `${scratch}/pglite-${scale}${quick ? '-quick' : ''}`,
    home: `${scratch}/home`, pgDataDir: str('pg-data-dir') ?? '/var/tmp/w1/pg16',
    only, quick, hnsw, importWorkers: int('import-workers', 1), poolMax: int('pool-max', 20),
    createDb: flags.has('create-db'), fresh: flags.has('fresh'), limitPages, maxSeconds: int('max-seconds', 120),
  };
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}
