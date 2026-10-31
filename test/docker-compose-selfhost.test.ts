/**
 * docker-compose.selfhost.yml — pins the contract that keeps the self-host
 * recipe from colliding with the init ladder's container or the CI compose
 * files. Pure: parses the YAML, never invokes docker.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: a self-hosted Postgres started from this file never adopts,
 *    shadows or is reclaimed by `gbrain-postgres` (the ladder container) or
 *    `db-repair`, never publishes beyond loopback, never ships a default
 *    password, and uses the same pgvector image the rest of gbrain pins.
 * 2. Fails when: someone renames the container, volume or port back onto the
 *    ladder's (or the CI files' 5434-5437), drops the loopback bind, gives the
 *    password a default, removes the healthcheck, or lets the image drift.
 * 3. Why not already covered: test/docker-postgres.test.ts pins the ladder's
 *    constants, nothing reads this file.
 * 4. No production seam: it imports the existing exported constants.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GBRAIN_PG_CONTAINER,
  GBRAIN_PG_HOST_PORT,
  GBRAIN_PG_IMAGE,
  isGbrainDockerUrl,
} from '../src/core/docker-postgres.ts';

const ROOT = join(import.meta.dir, '..');
const compose = Bun.YAML.parse(
  readFileSync(join(ROOT, 'docker-compose.selfhost.yml'), 'utf-8'),
) as {
  services: Record<string, any>;
  name: string;
  volumes: Record<string, unknown>;
};
const svc = compose.services.postgres;
// Host ports the ladder container and the CI/E2E compose files already use.
const TAKEN_PORTS = [GBRAIN_PG_HOST_PORT, 5435, 5436, 5437];

function hostPort(): { host: string; port: number } {
  const m = String(svc.ports[0]).match(/^([\d.]+):\$\{GBRAIN_SELFHOST_PG_PORT:-(\d+)\}:5432$/);
  expect(m).not.toBeNull();
  return { host: m![1]!, port: Number(m![2]) };
}

describe('docker-compose.selfhost.yml', () => {
  it('declares a single postgres service', () => {
    expect(Object.keys(compose.services)).toEqual(['postgres']);
  });

  it("uses names and a port distinct from the init ladder's container", () => {
    expect(svc.container_name).not.toBe(GBRAIN_PG_CONTAINER);
    const volume = String(svc.volumes[0]).split(':')[0];
    expect(volume).not.toBe('gbrain-pgdata');
    expect(Object.keys(compose.volumes)).toEqual([volume]);
    // The real (not directory-prefixed) volume name is pinned too.
    expect((compose.volumes[volume] as { name?: string }).name).toBe(volume);
    expect(compose.name).toBe('gbrain-selfhost');
    const { port } = hostPort();
    expect(TAKEN_PORTS).not.toContain(port);
    // db-repair must not claim a URL on this port as the ladder's container.
    expect(isGbrainDockerUrl(`postgresql://gbrain:x@localhost:${port}/gbrain`)).toBe(false);
  });

  it('publishes on loopback only', () => {
    expect(hostPort().host).toBe('127.0.0.1');
  });

  it('refuses to start without a password (no default)', () => {
    const pw = String(svc.environment.POSTGRES_PASSWORD);
    expect(pw).toContain('${GBRAIN_SELFHOST_PG_PASSWORD:?');
    expect(pw).not.toContain(':-');
  });

  it('pins the same pgvector image as the ladder', () => {
    expect(svc.image).toBe(GBRAIN_PG_IMAGE);
  });

  it('has a pg_isready healthcheck and restarts unless stopped', () => {
    expect(String(svc.healthcheck.test)).toContain('pg_isready');
    expect(svc.restart).toBe('unless-stopped');
  });

  it('ships an env example that names the password variable and no value', () => {
    const example = readFileSync(join(ROOT, 'docker-compose.selfhost.env.example'), 'utf-8');
    expect(example).toMatch(/^GBRAIN_SELFHOST_PG_PASSWORD=$/m);
  });
});
