import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCTOR_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'doctor.ts'),
  'utf8',
);

function contentSanityDoctorBlock(): string {
  const start = DOCTOR_SOURCE.indexOf('const fullContentAudit = args.includes');
  const end = DOCTOR_SOURCE.indexOf('progress.heartbeat(\'content_sanity_audit_recent\')', start);
  if (start < 0 || end < 0) throw new Error('content sanity doctor block not found');
  return DOCTOR_SOURCE.slice(start, end);
}

describe('doctor content-sanity DB checks', () => {
  test('oversized and scraper-junk scans use the connected engine, not the Postgres singleton', () => {
    const block = contentSanityDoctorBlock();

    expect(block).toContain('engine.executeRaw');
    expect(block).not.toContain('db.getConnection()');
  });

  test('recent content-sanity check filters acknowledged backlog', () => {
    expect(DOCTOR_SOURCE).toContain('unacknowledgedContentSanityEvents');
    expect(DOCTOR_SOURCE).toContain('No unacknowledged content-sanity events');
    expect(DOCTOR_SOURCE).toContain('gbrain doctor --acknowledge content_sanity_audit_recent');
  });

  test('doctor exposes a focused acknowledge surface for content-sanity backlog', () => {
    expect(DOCTOR_SOURCE).toContain("args.indexOf('--acknowledge')");
    expect(DOCTOR_SOURCE).toContain("acknowledgeTarget !== 'content_sanity_audit_recent'");
    expect(DOCTOR_SOURCE).toContain('acknowledgeContentSanityEvents');
  });
});
