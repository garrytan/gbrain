/**
 * docker-postgres — the PURE parts of gbrain's own-container seam only.
 * Never invokes real docker: `isGbrainDockerUrl` is string classification,
 * and the exported constants are the DRY contract between the init ladder's
 * docker rung and db-repair's conn_refused auto arm (the container name and
 * image must never fork into two drifting literals).
 */

import { describe, expect, it } from 'bun:test';

import {
  GBRAIN_PG_CONTAINER,
  GBRAIN_PG_HOST_PORT,
  GBRAIN_PG_IMAGE,
  isGbrainDockerUrl,
} from '../src/core/docker-postgres.ts';

describe('isGbrainDockerUrl', () => {
  it('matches localhost on the dedicated port, both loopback spellings', () => {
    expect(isGbrainDockerUrl('postgresql://u:p@localhost:5434/db')).toBe(true);
    expect(isGbrainDockerUrl('postgresql://u:p@127.0.0.1:5434/db')).toBe(true);
    // Both schemes classify the same way.
    expect(isGbrainDockerUrl('postgres://u:p@localhost:5434/db')).toBe(true);
  });

  it('rejects other ports — even other local Postgres servers', () => {
    expect(isGbrainDockerUrl('postgresql://u:p@localhost:5432/db')).toBe(false);
    expect(isGbrainDockerUrl('postgresql://u:p@127.0.0.1:5433/db')).toBe(false);
    expect(isGbrainDockerUrl('postgresql://u:p@localhost:59999/db')).toBe(false);
  });

  it('rejects non-loopback hosts, even on the dedicated port', () => {
    expect(isGbrainDockerUrl('postgresql://u:p@db.example.com:5434/db')).toBe(false);
    expect(isGbrainDockerUrl('postgresql://u:p@192.168.1.10:5434/db')).toBe(false);
    expect(isGbrainDockerUrl('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5434/postgres')).toBe(false);
  });

  it('returns false (never throws) on garbage input', () => {
    expect(isGbrainDockerUrl('')).toBe(false);
    expect(isGbrainDockerUrl('not a url at all')).toBe(false);
    expect(isGbrainDockerUrl('localhost:5434')).toBe(false);
    expect(isGbrainDockerUrl('://:5434')).toBe(false);
  });
});

describe('constants pinned (the DRY seam between the init rung and the repair arm)', () => {
  it('container name, image, and host port are the published contract', () => {
    expect(GBRAIN_PG_CONTAINER).toBe('gbrain-postgres');
    expect(GBRAIN_PG_IMAGE).toBe('pgvector/pgvector:pg16');
    // The port backs isGbrainDockerUrl's match — pin it so a drift is loud.
    expect(GBRAIN_PG_HOST_PORT).toBe(5434);
  });
});
