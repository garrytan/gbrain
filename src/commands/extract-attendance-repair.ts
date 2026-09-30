import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { loadConfig, isThinClient, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { readRepairSidecar } from '../core/pglite-repair.ts';
import { applyAttendanceRepair, previewAttendanceRepair, attendanceRepairHash, assertAttendanceRepairAuthority,
  validateAttendanceRepairScope, ATTENDANCE_REPAIR_LIMIT, type AttendanceRepairPreview,
  type AttendanceRepairAuthority } from '../core/attendance-repair.ts';

export const ATTENDANCE_REPAIR_HELP = `  gbrain extract links --source db --repair-attendance --source-id ID
                          [--limit 250] [--after-slug SLUG] [--json]
      Read-only attendance preview (maximum 1000 source pages), JSON receipt on stdout.
      Only trusted local callers; no filesystem/stale/global extraction modes.
      Apply the exact private preview with --apply-preview FILE --confirm DIGEST
      --yes --backup-verified --checkpoint FILE. Requires a verified full DB backup.
      See docs/guides/attendance-evidence.md for bounds and pack exclusions.
`;

export function isAttendanceRepairRequest(args: string[]) {
  return args.some(arg => ['--repair-attendance', '--apply-preview', '--backup-verified', '--confirm', '--checkpoint'].includes(arg.split('=')[0]));
}

export function attendanceRepairConnectionIdentity(brainId: string, connection: EngineConfig) {
  if (connection.engine === 'pglite') {
    if (!connection.database_path || connection.database_path.includes('\0')) throw new Error('Attendance repair requires an explicit PGLite path');
    return attendanceRepairHash([brainId, { engine: 'pglite', path: resolve(connection.database_path) }]);
  }
  try {
    if (connection.engine && connection.engine !== 'postgres') throw new Error();
    const value = connection.database_url;
    if (!value || /[\x00-\x20\x7f]/.test(value)) throw new Error();
    const match = value.match(/^(postgres(?:ql)?:)\/\/([^/?#]+)(\/[^?#]*)(?:\?([^#]*))?$/i);
    if (!match || match[2].indexOf('@') !== match[2].lastIndexOf('@')) throw new Error();
    const scheme = match[1].toLowerCase();
    const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
    const hosts = authority.split(',').map(host => {
      if (!host || host.includes('%')) throw new Error();
      const parsed = new URL(`${scheme}//${host}/`);
      if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error();
      return parsed;
    });
    const query = new URLSearchParams(match[4]);
    if ([...query.keys()].some(key => ['host', 'hostaddr', 'hostname', 'port', 'database', 'dbname', 'db', 'path', 'service', 'servicefile']
      .includes(key.toLowerCase()))) throw new Error();
    const database = new URL(`${scheme}//${authority.split(',')[0]}${match[3]}`).pathname.slice(1);
    if (!database) throw new Error();
    const fallbackPort = hosts[0].port || process.env.PGPORT || '5432';
    const endpoints = hosts.map(host => {
      const port = host.port || fallbackPort;
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error();
      return [host.hostname.toLowerCase(), Number(port)];
    });
    return attendanceRepairHash([brainId, { engine: 'postgres', scheme, hosts: endpoints, database }]);
  } catch {
    throw new Error('Attendance repair requires a supported explicit PostgreSQL endpoint and database');
  }
}

export function parseAttendanceRepairArgs(args: string[], authority: AttendanceRepairAuthority) {
  assertAttendanceRepairAuthority(authority);
  if (args[0] !== 'links') throw new Error('Attendance repair requires extract links');
  const values = new Map<string, string | boolean>();
  const booleans = new Set(['--repair-attendance', '--yes', '--backup-verified', '--json', '--dry-run']);
  const valued = new Set(['--source', '--source-id', '--limit', '--after-slug', '--apply-preview', '--confirm', '--checkpoint']);
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (values.has(flag)) throw new Error('Repeated attendance repair flag');
    if (booleans.has(flag)) values.set(flag, true);
    else if (valued.has(flag) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(flag, args[++index]);
    else throw new Error('Unsupported attendance repair flag or combination');
  }
  if (!values.has('--repair-attendance') || values.get('--source') !== 'db' || !values.get('--source-id')) {
    throw new Error('Attendance repair requires --source db --repair-attendance --source-id ID');
  }
  const sourceId = values.get('--source-id') as string;
  const limit = values.has('--limit') ? Number(values.get('--limit')) : ATTENDANCE_REPAIR_LIMIT;
  const afterSlug = values.get('--after-slug') as string | undefined;
  validateAttendanceRepairScope(sourceId, limit, afterSlug);
  const apply = values.get('--apply-preview') as string | undefined;
  const confirm = values.get('--confirm') as string | undefined;
  const checkpoint = values.get('--checkpoint') as string | undefined;
  if (apply) {
    if (!values.has('--yes') || !values.has('--backup-verified') || !confirm || !/^[a-f0-9]{64}$/.test(confirm) || !checkpoint
      || ['--dry-run', '--limit', '--after-slug'].some(flag => values.has(flag))) {
      throw new Error('Apply requires --apply-preview FILE --confirm DIGEST --yes --backup-verified --checkpoint FILE; no scan or dry-run flags');
    }
    if (resolve(apply) === resolve(checkpoint)) throw new Error('Preview and checkpoint paths must differ');
  } else if (['--yes', '--backup-verified', '--confirm', '--checkpoint'].some(flag => values.has(flag))) {
    throw new Error('Apply confirmation requires --apply-preview FILE');
  }
  return { sourceId, limit, afterSlug, apply, confirm, checkpoint, json: values.has('--json') };
}

function privateStat(path: string, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Repair receipt and checkpoint must be private, owned, non-symlink files in a private directory');
  }
  return stat;
}

function readPrivateJson(path: string) {
  privateStat(dirname(resolve(path)), true);
  privateStat(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 ** 2 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid or oversized private repair receipt');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export async function runAttendanceRepair(engine: BrainEngine, args: string[], authority: AttendanceRepairAuthority,
  brainIdentity?: string) {
  const options = parseAttendanceRepairArgs(args, authority);
  if (!options.apply) {
    const preview = await previewAttendanceRepair(engine, { ...options, remote: false, brainIdentity });
    if (!options.json) console.error(`Attendance preview: ${preview.counts.scanned} source pages scanned, ${preview.counts.eligibleOrigins} eligible origins, ${preview.counts.changed} changed; ${preview.counts.add} add, ${preview.counts.remove} remove, ${preview.counts.skipped} skipped. Frontmatter is report-only. No changes applied.`);
    process.stdout.write(JSON.stringify(preview) + '\n');
    return preview;
  }
  const preview = readPrivateJson(options.apply) as AttendanceRepairPreview;
  const checkpoint = resolve(options.checkpoint!);
  privateStat(dirname(checkpoint), true);
  if (existsSync(checkpoint)) {
    const previous = readPrivateJson(checkpoint);
    if (previous.digest !== preview.digest || previous.sourceIncarnation !== preview.sourceIncarnation
      || previous.ontology !== preview.ontology) throw new Error('Checkpoint belongs to another preview, source or ontology');
  }
  const result = await applyAttendanceRepair(engine, preview, { remote: false, sourceId: options.sourceId,
    brainIdentity, confirm: options.confirm!, yes: true, backupVerified: true,
    checkpoint: async state => {
      privateStat(dirname(checkpoint), true);
      if (existsSync(checkpoint)) privateStat(checkpoint);
      const temporary = `${checkpoint}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { renameSync(temporary, checkpoint); }
      catch (error) { unlinkSync(temporary); throw error; }
      const directory = openSync(dirname(checkpoint), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } });
  process.stdout.write(JSON.stringify({ digest: preview.digest, ...result }) + '\n');
  return result;
}

export async function runAttendanceRepairCli(args: string[], brainFlag: string | null) {
  parseAttendanceRepairArgs(args, { remote: false });
  const config = loadConfig();
  if (isThinClient(config)) throw new Error('Attendance repair is unavailable to remote or thin clients');
  const brainId = resolveBrainId(brainFlag);
  let connection: EngineConfig;
  if (brainId === 'host') {
    if (!config) throw new Error('Attendance repair requires an existing configured brain');
    connection = toEngineConfig(config);
  } else {
    const mount = loadMounts().find(entry => entry.id === brainId && entry.enabled !== false);
    if (!mount) throw new Error('Attendance repair requires an existing direct local mount');
    connection = { engine: mount.engine, database_url: mount.database_url, database_path: mount.database_path };
  }
  if (connection.engine === 'pglite') {
    if (!connection.database_path || !existsSync(join(connection.database_path, 'PG_VERSION')))
      throw new Error('Attendance repair cannot create a PGLite database');
    if (readRepairSidecar(connection.database_path).episodeStartedAt !== null)
      throw new Error('Resolve the existing PGLite repair episode before attendance preview');
  } else if (!connection.database_url) throw new Error('Attendance repair requires an existing database URL');
  const brainIdentity = attendanceRepairConnectionIdentity(brainId, connection);
  const engine = await createEngine(connection);
  const previousRepair = process.env.GBRAIN_PGLITE_WAL_REPAIR;
  process.env.GBRAIN_PGLITE_WAL_REPAIR = 'off';
  try {
    await engine.connect({ ...connection, poolSize: 1 } as EngineConfig & { poolSize: number });
    await runAttendanceRepair(engine, args, { remote: false }, brainIdentity);
  } finally {
    await engine.disconnect();
    if (previousRepair === undefined) delete process.env.GBRAIN_PGLITE_WAL_REPAIR;
    else process.env.GBRAIN_PGLITE_WAL_REPAIR = previousRepair;
  }
}
