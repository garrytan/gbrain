/**
 * gbrain's OWN docker Postgres container — the shared seam between the init
 * ladder's docker rung (`gbrain init --prefer-postgres --allow-docker`) and
 * db-repair's `conn_refused` auto arm (`docker start` a stopped container).
 *
 * The container name lives HERE and only here (DRY: the init rung and the
 * repair arm must never carry two string literals that can drift).
 *
 * Ownership contract: gbrain starts and reuses this container; it NEVER
 * stops or removes it, and never touches a container whose credentials it
 * cannot recover via `docker inspect` (a container we can't prove we own is
 * not ours to recreate).
 */

import { spawnSync } from 'node:child_process';

export const GBRAIN_PG_CONTAINER = 'gbrain-postgres';
export const GBRAIN_PG_IMAGE = 'pgvector/pgvector:pg16';
export const GBRAIN_PG_HOST_PORT = 5434;

function docker(
  args: string[],
  extraEnv?: Record<string, string>,
  timeoutMs = 30_000,
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

/**
 * Does this URL point at gbrain's own docker container? Used by db-repair's
 * `conn_refused` arm to decide whether the `docker start` auto fix applies —
 * matching on the loopback host + our dedicated port, never on error text.
 */
export function isGbrainDockerUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.port === String(GBRAIN_PG_HOST_PORT)
    );
  } catch {
    return false;
  }
}

export function dockerAvailable(): boolean {
  try {
    return docker(['--version']).ok;
  } catch {
    return false;
  }
}

export type ContainerState = 'absent' | 'running' | 'stopped';

export function containerState(name: string = GBRAIN_PG_CONTAINER): ContainerState {
  const res = docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']);
  if (!res.ok || res.stdout === '') return 'absent';
  return res.stdout.split('\n')[0] === 'running' ? 'running' : 'stopped';
}

export function startContainer(name: string = GBRAIN_PG_CONTAINER): boolean {
  return docker(['start', name]).ok;
}

export interface ContainerCredentials {
  password: string;
  hostPort: number;
}

/**
 * Recover the REAL credentials of an existing container. A freshly generated
 * password can never match a surviving container, and `docker start` reuses
 * the container's ORIGINAL port mapping — so reuse must read both from
 * `docker inspect`, never assume them. Returns null when either is
 * unrecoverable (the caller refuses with a recreate-with-consent recipe).
 */
export function inspectCredentials(name: string = GBRAIN_PG_CONTAINER): ContainerCredentials | null {
  const res = docker(['inspect', name]);
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout) as Array<{
      Config?: { Env?: string[] };
      HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }>> };
    }>;
    const info = parsed[0];
    const envs = info?.Config?.Env ?? [];
    const pwEntry = envs.find((e) => e.startsWith('POSTGRES_PASSWORD='));
    if (!pwEntry) return null;
    const password = pwEntry.slice('POSTGRES_PASSWORD='.length);
    const bindings = info?.HostConfig?.PortBindings?.['5432/tcp'];
    const hostPort = bindings?.[0]?.HostPort ? Number(bindings[0].HostPort) : GBRAIN_PG_HOST_PORT;
    if (!password || !Number.isFinite(hostPort)) return null;
    return { password, hostPort };
  } catch {
    return null;
  }
}

/**
 * Create + start a fresh container. The password rides the child ENVIRONMENT
 * (bare `-e POSTGRES_PASSWORD` inherits from the docker client's env), never
 * argv — argv is world-readable in `ps` for the life of the spawn. Port
 * binds loopback-only (this is a single-machine brain store, not a network
 * service) and data lives on a named volume so a container recreate never
 * loses the brain.
 */
export function runNewContainer(password: string): { ok: boolean; stderr: string } {
  const res = docker(
    [
      'run', '-d',
      '--name', GBRAIN_PG_CONTAINER,
      '--restart', 'unless-stopped',
      '-e', 'POSTGRES_PASSWORD',
      '-v', 'gbrain-pgdata:/var/lib/postgresql/data',
      '-p', `127.0.0.1:${GBRAIN_PG_HOST_PORT}:5432`,
      GBRAIN_PG_IMAGE,
    ],
    { POSTGRES_PASSWORD: password },
    // First-ever run synchronously PULLS the image (hundreds of MB) — the
    // default 30s cap (right for cheap ps/inspect/start calls) would fail
    // essentially every fresh --allow-docker install on a cold image cache.
    10 * 60_000,
  );
  return { ok: res.ok, stderr: res.stderr };
}
