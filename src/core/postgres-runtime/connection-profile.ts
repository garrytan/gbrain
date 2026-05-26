import type { MBrainConfig } from '../config.ts';
import { MBrainError } from '../types.ts';

export interface RuntimeDatabaseIdentity {
  safeDsn: string;
  user: string;
  host: string;
  port: number | null;
  database: string;
  isRemote: boolean;
}

export interface PostgresRuntimeProfile {
  engine: 'postgres';
  database: RuntimeDatabaseIdentity & { url: string };
  pool: {
    max: number;
  };
  clients: {
    cli: string;
    mcp: string;
    autopilot: string;
  };
}

const DEFAULT_POSTGRES_RUNTIME_POOL_MAX = 5;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

export function resolvePostgresRuntimeProfile(config: MBrainConfig): PostgresRuntimeProfile {
  assertPostgresRuntimeFeatureAllowed(config, 'postgres runtime');
  const identity = describeRuntimeDatabaseIdentity(config);

  return {
    engine: 'postgres',
    database: {
      ...identity,
      url: identity.safeDsn,
    },
    pool: {
      max: DEFAULT_POSTGRES_RUNTIME_POOL_MAX,
    },
    clients: {
      cli: identity.safeDsn,
      mcp: identity.safeDsn,
      autopilot: identity.safeDsn,
    },
  };
}

export function assertPostgresRuntimeFeatureAllowed(config: MBrainConfig, featureName: string): void {
  if (config.engine === 'postgres') return;

  throw new MBrainError(
    'Postgres runtime feature unavailable',
    `${featureName} requires engine="postgres"; current engine is "${config.engine}"`,
    'Initialize or switch to a Postgres-backed runtime before using this feature',
  );
}

export function assertExplicitRemoteDsn(config: MBrainConfig): void {
  const identity = describeRuntimeDatabaseIdentity(config);
  if (!identity.isRemote || config.database_url_explicit) return;

  throw new MBrainError(
    'Remote Postgres DSN requires explicit opt-in',
    `${identity.safeDsn} points to a non-local Postgres host`,
    'Pass --dsn/--url explicitly or save database_url_explicit=true with the configured database_url',
  );
}

export function describeRuntimeDatabaseIdentity(config: MBrainConfig): RuntimeDatabaseIdentity {
  if (config.engine !== 'postgres') {
    throw new MBrainError(
      'Postgres runtime identity unavailable',
      `database identity requires engine="postgres"; current engine is "${config.engine}"`,
      'Use a Postgres-backed runtime for Postgres runtime identity checks',
    );
  }

  if (!config.database_url) {
    throw new MBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run mbrain init --dsn <connection_string> or set MBRAIN_DATABASE_URL / DATABASE_URL',
    );
  }

  return parsePostgresDsn(config.database_url);
}

export function formatRuntimeDatabaseIdentity(profile: PostgresRuntimeProfile): string {
  const label = databaseLabel(profile.database);
  return `cli=${label}; mcp=${label}; autopilot=${label}; pool_max=${profile.pool.max}`;
}

function parsePostgresDsn(dsn: string): RuntimeDatabaseIdentity {
  const safeDsn = redactPostgresDsn(dsn);

  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('unsupported protocol');
    }

    const socketHost = parsed.searchParams.get('host');
    const host = socketHost ? decodeURIComponent(socketHost) : decodeURIComponent(parsed.hostname);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) || 'postgres';
    const user = decodeURIComponent(parsed.username || 'postgres');
    const port = parsed.port ? Number(parsed.port) : null;

    return {
      safeDsn,
      user,
      host,
      port,
      database,
      isRemote: isRemoteHost(host),
    };
  } catch {
    const match = dsn.match(/^postgres(?:ql)?:\/\/([^:/@]+)(?::[^@]*)?@([^:/?]+)(?::(\d+))?\/([^?]+)/);
    if (!match) {
      return {
        safeDsn,
        user: 'unknown',
        host: 'unknown',
        port: null,
        database: 'unknown',
        isRemote: true,
      };
    }

    const [, user, host, port, database] = match;
    return {
      safeDsn,
      user,
      host,
      port: port ? Number(port) : null,
      database,
      isRemote: isRemoteHost(host),
    };
  }
}

function redactPostgresDsn(dsn: string): string {
  try {
    const parsed = new URL(dsn);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return dsn.replace(/(postgres(?:ql)?:\/\/[^:/@]+:)([^@]*)(@)/, '$1***$3');
  }
}

function isRemoteHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return false;
  return !host.startsWith('/');
}

function databaseLabel(identity: RuntimeDatabaseIdentity): string {
  const port = identity.port ? `:${identity.port}` : '';
  return `${identity.user}@${identity.host}${port}/${identity.database}`;
}
