/**
 * #3875 — embedding-infra failures must never ride the auto-skip valve.
 *
 * Pure-function coverage (no ledger file, no DB):
 *
 *   1. classifyErrorCode maps the gateway's per-sub-batch timeout message
 *      (`[embed(provider:model)] The operation timed out.`) to
 *      EMBEDDING_TIMEOUT instead of UNKNOWN.
 *   2. decideGateAction accepts per-path codes and treats
 *      EMBEDDING_{TIMEOUT,RATE_LIMIT,QUOTA} as never-chronic: a provider
 *      outage BLOCKS the bookmark instead of silently auto-skipping every
 *      file that synced while the provider was unhealthy.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyErrorCode,
  decideGateAction,
  isEmbeddingInfraCode,
  EMBEDDING_INFRA_CODES,
} from '../src/core/sync-failure-ledger.ts';

describe('#3875 classifyErrorCode — embed-scoped timeouts', () => {
  test('gateway sub-batch timeout message classifies as EMBEDDING_TIMEOUT, not UNKNOWN', () => {
    expect(
      classifyErrorCode('[embed(ollama:nomic-embed-text)] The operation timed out.'),
    ).toBe('EMBEDDING_TIMEOUT');
  });

  test('other providers and phrasings still classify', () => {
    expect(
      classifyErrorCode('[embed(voyage:voyage-3-large)] Request timeout after 60000ms'),
    ).toBe('EMBEDDING_TIMEOUT');
    expect(
      classifyErrorCode('[embedMultimodal(voyage:voyage-multimodal-3)] The operation timed out.'),
    ).toBe('EMBEDDING_TIMEOUT');
  });

  test('a bare timeout with no embed context stays UNKNOWN (scope stays tight)', () => {
    expect(classifyErrorCode('The operation timed out.')).toBe('UNKNOWN');
  });

  test('DB statement timeouts are NOT reclassified', () => {
    expect(
      classifyErrorCode('canceling statement due to statement timeout'),
    ).toBe('STATEMENT_TIMEOUT');
  });

  test('429 control case still maps to EMBEDDING_RATE_LIMIT', () => {
    expect(classifyErrorCode('[embed(openai:text-embedding-3-small)] 429 too many requests')).toBe(
      'EMBEDDING_RATE_LIMIT',
    );
  });
});

describe('#3875 isEmbeddingInfraCode', () => {
  test('the three provider-infra codes are infra; file-poison codes are not', () => {
    for (const code of ['EMBEDDING_TIMEOUT', 'EMBEDDING_RATE_LIMIT', 'EMBEDDING_QUOTA']) {
      expect(EMBEDDING_INFRA_CODES.has(code)).toBe(true);
      expect(isEmbeddingInfraCode(code)).toBe(true);
    }
    for (const code of ['YAML_PARSE', 'EMBEDDING_OVERSIZE', 'UNKNOWN', undefined]) {
      expect(isEmbeddingInfraCode(code)).toBe(false);
    }
  });
});

describe('#3875 decideGateAction — infra codes never auto-skip', () => {
  const base = {
    sentinels: [] as Array<{ path: string }>,
    threshold: 3,
    skipFailed: false,
  };

  test('chronic file WITH an infra code blocks instead of auto-skipping', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [{ path: 'notes/a.md', code: 'EMBEDDING_TIMEOUT' }],
      attemptsByPath: new Map([['notes/a.md', 5]]),
    });
    expect(d.action).toBe('block');
    expect(d.autoSkipPaths).toEqual([]);
  });

  test('chronic file with a poison code still auto-skips (valve unchanged)', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [{ path: 'notes/a.md', code: 'YAML_PARSE' }],
      attemptsByPath: new Map([['notes/a.md', 5]]),
    });
    expect(d.action).toBe('advance_then_autoskip');
    expect(d.autoSkipPaths).toEqual(['notes/a.md']);
  });

  test('mixed chronic poison + chronic infra blocks the whole gate', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [
        { path: 'notes/poison.md', code: 'YAML_PARSE' },
        { path: 'notes/good-but-provider-down.md', code: 'EMBEDDING_RATE_LIMIT' },
      ],
      attemptsByPath: new Map([
        ['notes/poison.md', 5],
        ['notes/good-but-provider-down.md', 5],
      ]),
    });
    expect(d.action).toBe('block');
    expect(d.autoSkipPaths).toEqual([]);
  });

  test('EMBEDDING_QUOTA behaves like TIMEOUT/RATE_LIMIT', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [{ path: 'notes/a.md', code: 'EMBEDDING_QUOTA' }],
      attemptsByPath: new Map([['notes/a.md', 99]]),
    });
    expect(d.action).toBe('block');
  });

  test('explicit --skip-failed still advances (human ack wins over the valve)', () => {
    const d = decideGateAction({
      ...base,
      skipFailed: true,
      fileFailures: [{ path: 'notes/a.md', code: 'EMBEDDING_TIMEOUT' }],
      attemptsByPath: new Map([['notes/a.md', 5]]),
    });
    expect(d.action).toBe('advance');
  });

  test('code-less failures keep pre-#3875 behavior (backward compatible)', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [{ path: 'notes/a.md' }],
      attemptsByPath: new Map([['notes/a.md', 5]]),
    });
    expect(d.action).toBe('advance_then_autoskip');
  });

  test('sentinels still hard-block regardless of codes', () => {
    const d = decideGateAction({
      ...base,
      fileFailures: [{ path: 'notes/a.md', code: 'EMBEDDING_TIMEOUT' }],
      sentinels: [{ path: '<head>' }],
      attemptsByPath: new Map([['notes/a.md', 5]]),
    });
    expect(d.action).toBe('hard_block');
  });
});
