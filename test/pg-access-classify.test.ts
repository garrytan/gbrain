/**
 * Classifier tests — the load-bearing suite for the db-availability loop.
 *
 * The redaction assertions here are the ENFORCEMENT for runtime redaction:
 * scripts/check-pg-url-redaction.sh only greps source literals, so these
 * tests are what actually guarantees a DSN never reaches a transcript.
 */
import { describe, expect, it } from 'bun:test';

import {
  DB_ACCESS_MARKER_PREFIX,
  classifyPgAccessError,
  diagnoseDbConfig,
  formatDbAccessMarker,
  type PgAccessDiagnosis,
  type PgAccessReason,
} from '../src/core/pg-access-classify.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

function errWithCode(code: string, message = 'synthetic'): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** (reason, code-form sample, message-form sample) triples for every
 *  error-derived reason in the union. */
const REASON_SAMPLES: Array<{
  reason: PgAccessReason;
  code?: Error;
  message: Error;
}> = [
  {
    reason: 'auth_failed',
    code: errWithCode('28P01', 'auth rejected'),
    message: new Error('FATAL: password authentication failed for user "postgres"'),
  },
  {
    reason: 'permission_denied',
    code: errWithCode('42501', 'denied'),
    message: new Error('permission denied for table pages'),
  },
  {
    reason: 'tenant_not_found',
    message: new Error('Tenant or user not found'),
  },
  {
    reason: 'ssl_required',
    message: new Error('no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption'),
  },
  {
    reason: 'pool_exhausted',
    code: errWithCode('53300', 'too many connections'),
    message: new Error('Max client connections reached: EMAXCONNSESSION'),
  },
  {
    reason: 'conn_refused',
    code: errWithCode('ECONNREFUSED', 'refused'),
    message: new Error('could not connect to server: Connection refused'),
  },
  {
    reason: 'dns_failed',
    code: errWithCode('ENOTFOUND', 'dns'),
    message: new Error('getaddrinfo EAI_AGAIN db.example.host'),
  },
  {
    reason: 'network_unreachable',
    code: errWithCode('ETIMEDOUT', 'timeout'),
    message: new Error('connect ENETUNREACH 2600:1f16::1:5432'),
  },
  {
    reason: 'conn_dropped',
    code: errWithCode('CONNECTION_ENDED', 'ended'),
    message: new Error('Connection terminated unexpectedly'),
  },
  {
    reason: 'server_starting',
    message: new Error('FATAL: the database system is starting up'),
  },
  {
    reason: 'db_missing',
    code: errWithCode('3D000', 'missing db'),
    message: new Error('database "gbrain" does not exist'),
  },
  {
    reason: 'schema_missing',
    code: errWithCode('42P01', 'missing rel'),
    message: new Error('relation "pages" does not exist'),
  },
  {
    reason: 'pgvector_missing',
    message: new Error('type "vector" does not exist'),
  },
];

describe('classifyPgAccessError — reason table', () => {
  for (const s of REASON_SAMPLES) {
    it(`classifies ${s.reason} from message form`, () => {
      expect(classifyPgAccessError(s.message).reason).toBe(s.reason);
    });
    if (s.code) {
      it(`classifies ${s.reason} from code form`, () => {
        expect(classifyPgAccessError(s.code).reason).toBe(s.reason);
      });
    }
  }

  it('classifies 08xxx SQLSTATEs (prefix match) as conn_dropped', () => {
    expect(classifyPgAccessError(errWithCode('08006', 'connection failure')).reason).toBe('conn_dropped');
    expect(classifyPgAccessError(errWithCode('08001', 'cannot establish')).reason).toBe('conn_dropped');
  });

  it('falls back to unknown (and never throws) on weird inputs', () => {
    expect(classifyPgAccessError(new Error('something else entirely')).reason).toBe('unknown');
    expect(classifyPgAccessError(null).reason).toBe('unknown');
    expect(classifyPgAccessError(undefined).reason).toBe('unknown');
    expect(classifyPgAccessError('a bare string error').reason).toBe('unknown');
    expect(classifyPgAccessError({ weird: true }).reason).toBe('unknown');
  });

  it('carries the sqlstate only when the code is SQLSTATE-shaped', () => {
    expect(classifyPgAccessError(errWithCode('28P01')).sqlstate).toBe('28P01');
    expect(classifyPgAccessError(errWithCode('ECONNREFUSED')).sqlstate).toBeUndefined();
  });

  it('carries brainId from ctx into the diagnosis and marker', () => {
    const d = classifyPgAccessError(errWithCode('ECONNREFUSED'), { brainId: 'team-brain' });
    expect(d.brainId).toBe('team-brain');
    expect(formatDbAccessMarker(d)).toBe(`${DB_ACCESS_MARKER_PREFIX} conn_refused brain=team-brain`);
  });
});

describe('redaction (the runtime enforcement)', () => {
  const DSN = 'postgresql://postgres.abc123:hunter2secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'; /* allow-pg-url-literal */

  it('never leaks a DSN, password, or IP through message/remediation', () => {
    const raw = new Error(
      `connection to server at "db.abc123.supabase.co" (1.2.3.4), port 5432 failed: could not connect to server: ${DSN} password=hunter2secret`,
    );
    const d = classifyPgAccessError(raw, { url: DSN });
    const flat = JSON.stringify(d);
    expect(flat).not.toContain('hunter2secret');
    expect(flat).not.toContain('1.2.3.4');
    expect(d.message).toContain('<REDACTED:');
  });
});

describe('transient axis — agreement with isRetryableConnError on shared classes', () => {
  const SHARED: Array<{ sample: Error; reason: PgAccessReason }> = [
    { sample: errWithCode('53300', 'too many connections'), reason: 'pool_exhausted' },
    { sample: new Error('FATAL: the database system is starting up'), reason: 'server_starting' },
    { sample: new Error('could not connect to server: Connection refused'), reason: 'conn_refused' },
    { sample: errWithCode('CONNECTION_ENDED', 'ended'), reason: 'conn_dropped' },
    { sample: errWithCode('08006', 'failure'), reason: 'conn_dropped' },
  ];
  for (const { sample, reason } of SHARED) {
    it(`${reason}: transient matches the retry axis`, () => {
      const d = classifyPgAccessError(sample);
      expect(d.reason).toBe(reason);
      expect(d.transient).toBe(isRetryableConnError(sample));
    });
  }

  it('auth_failed DIVERGES on purpose: retryable on the retry axis, not transient here', () => {
    const sample = new Error('password authentication failed for user "postgres"');
    expect(isRetryableConnError(sample)).toBe(true); // retry-matcher's deliberate call
    const d = classifyPgAccessError(sample);
    expect(d.reason).toBe('auth_failed');
    expect(d.transient).toBe(false); // this module's deliberate call
  });
});

describe('fix descriptors — hardcoded, config-URL-derived, never from error text', () => {
  function everyFix(d: PgAccessDiagnosis): void {
    if (!d.fix) return;
    if (d.fix.kind === 'run_command') expect(d.fix.argv[0]).toBe('gbrain');
  }

  it('run_command argv[0] is always gbrain', () => {
    for (const s of REASON_SAMPLES) {
      everyFix(classifyPgAccessError(s.message));
      if (s.code) everyFix(classifyPgAccessError(s.code));
    }
    const noUrl = diagnoseDbConfig({ source: null, envShadowed: false });
    if (noUrl) everyFix(noUrl);
  });

  it('conn_refused on a Supabase DIRECT url derives the transaction-pooler rewrite', () => {
    const direct = 'postgresql://postgres:pw@db.abc123.supabase.co:5432/postgres'; /* allow-pg-url-literal */
    const d = classifyPgAccessError(errWithCode('ECONNREFUSED'), { url: direct });
    expect(d.fix).toEqual({ kind: 'rewrite_config_url', to: 'transaction_pooler' });
  });

  it('conn_refused on a NON-supabase url carries no rewrite fix', () => {
    const local = 'postgresql://me:pw@localhost:5434/gbrain'; /* allow-pg-url-literal */
    const d = classifyPgAccessError(errWithCode('ECONNREFUSED'), { url: local });
    expect(d.fix).toBeUndefined();
  });

  it('network_unreachable on a derivable url derives the session-pooler rewrite', () => {
    const pooler = 'postgresql://postgres.abc123:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'; /* allow-pg-url-literal */
    const d = classifyPgAccessError(errWithCode('ETIMEDOUT'), { url: pooler });
    expect(d.fix).toEqual({ kind: 'rewrite_config_url', to: 'session_pooler' });
  });
});

describe('supabase enrichment', () => {
  const POOLER = 'postgresql://postgres.abc123:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'; /* allow-pg-url-literal */

  it('flags pausedSuspect on dns/timeout/tenant reasons against supabase hosts', () => {
    for (const err of [errWithCode('ENOTFOUND'), errWithCode('ETIMEDOUT'), new Error('Tenant or user not found')]) {
      const d = classifyPgAccessError(err, { url: POOLER });
      expect(d.supabase?.pausedSuspect).toBe(true);
      expect(d.supabase?.pooler).toBe(true);
      expect(d.supabase?.projectRef).toBe('abc123');
    }
  });

  it('does not flag pausedSuspect on non-pause reasons or non-supabase urls', () => {
    expect(classifyPgAccessError(errWithCode('ECONNREFUSED'), { url: POOLER }).supabase?.pausedSuspect).toBe(false);
    expect(classifyPgAccessError(errWithCode('ENOTFOUND'), { url: 'postgresql://me:pw@localhost:5432/db' }).supabase).toBeUndefined(); /* allow-pg-url-literal */
  });
});

describe('diagnoseDbConfig — the errorless config plane', () => {
  it('returns null when a source exists (config plane is fine)', () => {
    expect(diagnoseDbConfig({ source: 'config-file', envShadowed: false })).toBeNull();
    expect(diagnoseDbConfig({ source: 'env:GBRAIN_DATABASE_URL', envShadowed: false })).toBeNull();
  });

  it('no_url when nothing is configured', () => {
    const d = diagnoseDbConfig({ source: null, envShadowed: false });
    expect(d?.reason).toBe('no_url');
    expect(d?.fix).toEqual({ kind: 'run_command', argv: ['gbrain', 'init', '--prefer-postgres'] });
  });

  it('env_shadowed when the #427 guard excluded a bare DATABASE_URL', () => {
    const d = diagnoseDbConfig({ source: null, envShadowed: true, brainId: 'host' });
    expect(d?.reason).toBe('env_shadowed');
    expect(d?.remediation).toContain('GBRAIN_DATABASE_URL');
  });
});

describe('marker contract (skill↔binary lockstep, the UPGRADE_AVAILABLE pattern)', () => {
  it('pins the literal prefix', () => {
    expect(DB_ACCESS_MARKER_PREFIX).toBe('GBRAIN_DB_ACCESS');
  });

  it('formats as PREFIX <reason> with an optional non-host brain suffix', () => {
    const d = classifyPgAccessError(errWithCode('ECONNREFUSED'));
    expect(formatDbAccessMarker(d)).toBe('GBRAIN_DB_ACCESS conn_refused');
  });

  it('the marker literal appears in skills/db-repair frontmatter description AND triggers', async () => {
    const skill = await Bun.file(new URL('../skills/db-repair/SKILL.md', import.meta.url)).text();
    const fm = skill.split('---')[1] ?? '';
    const descBlock = fm.slice(fm.indexOf('description:'), fm.indexOf('triggers:'));
    const trigBlock = fm.slice(fm.indexOf('triggers:'));
    expect(descBlock).toContain(DB_ACCESS_MARKER_PREFIX);
    expect(trigBlock).toContain(`"${DB_ACCESS_MARKER_PREFIX}"`);
  });
});
