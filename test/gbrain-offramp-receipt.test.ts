import { describe, expect, test } from 'bun:test';

import {
  extractLastJsonBlock,
  summarizeReceipt,
} from '../scripts/gbrain-offramp-receipt.ts';

describe('gbrain-offramp-receipt helpers', () => {
  test('extractLastJsonBlock returns the final JSON object after progress chatter', () => {
    const raw = [
      '[doctor] planning remediation',
      '{"ignore":"first"}',
      '[doctor] almost there',
      '{"active":true,"plan":[{"step":1}]}',
    ].join('\n');

    expect(extractLastJsonBlock(raw)).toBe('{"active":true,"plan":[{"step":1}]}');
  });

  test('summarizeReceipt surfaces active source, default backlog, autopilot state, max reachable score, and recommended commands', () => {
    const summary = summarizeReceipt({
      activeSource: {
        source_id: 'gbrain',
        tier: 'local_path',
        detail: '/Users/sawbeck/gbrain',
        resolver_chain: ['local_path'],
      },
      features: {
        version: '0.41.36.0',
        scan_ts: '2026-06-03T21:26:56.760Z',
        brain_score: 37,
        recommendations: [
          {
            id: 'missing-embeddings',
            priority: 1,
            title: 'Fix Missing Embeddings',
            pitch: '7800 chunks invisible to semantic search. One command fixes it.',
            command: 'gbrain embed --stale',
            auto_fixable: true,
          },
        ],
      },
      status: {
        schema_version: 1,
        generated_at: '2026-06-03T21:26:57.674Z',
        mode: 'local',
        sync: {
          schema_version: 1,
          generated_at: '2026-06-03T21:26:57.720Z',
          sources: [
            {
              source_id: 'default',
              name: 'default',
              local_path: null,
              sync_enabled: true,
              last_sync_at: null,
              staleness_hours: null,
              staleness_class: 'unknown',
              last_commit: null,
              pages: 1889,
              chunks_total: 7800,
              chunks_unembedded: 7800,
              embedding_coverage_pct: 0,
              backfill_queued: 0,
              backfill_active: 0,
              backfill_last_completed_at: null,
            },
            {
              source_id: 'gbrain',
              name: 'gbrain',
              local_path: '/Users/sawbeck/gbrain',
              sync_enabled: true,
              last_sync_at: '2026-06-03T01:22:49.967Z',
              staleness_hours: 0,
              staleness_class: 'fresh',
              last_commit: '16346856a10e52e693326a51129b160afb5c37f4',
              pages: 323,
              chunks_total: 1798,
              chunks_unembedded: 0,
              embedding_coverage_pct: 100,
              backfill_queued: 0,
              backfill_active: 0,
              backfill_last_completed_at: null,
            },
          ],
          unacknowledged_failures: 128,
          embedding_column: 'embedding',
        },
        cycle: {
          last_full: null,
          last_targeted: null,
        },
        locks: [],
        workers: {
          crashes_24h: 0,
          clean_exits_24h: 0,
          by_cause: {
            runtime_error: 0,
            oom_or_external_kill: 0,
            unknown: 0,
            legacy: 0,
          },
          last_event_ts: null,
        },
        queue: {
          active: 0,
          waiting: 1,
          completed: 0,
          failed: 0,
          dead: 0,
        },
        autopilot: {
          installed: false,
          lockfile_present: false,
          pid: null,
          running: false,
        },
      },
      remediationPlan: {
        schema_version: 2,
        brain_score_current: 37,
        brain_score_target: 90,
        max_reachable_score: 73,
        target_unreachable: true,
        plan: [
          {
            step: 1,
            id: 'embed.stale',
            job: 'embed',
            params: { stale: true },
            idempotency_key: 'default:embed:497c89e9',
            severity: 'critical',
            est_seconds: 395,
            est_usd_cost: 0,
            depends_on: ['sync.repo'],
            rationale: '7800 chunks invisible to vector search',
            status: 'remediable',
          },
          {
            step: 2,
            id: 'sync.repo',
            job: 'sync',
            params: {
              repoPath: '/Users/sawbeck/gbrain',
              noEmbed: true,
            },
            idempotency_key: 'default:sync:0df2faba',
            severity: 'high',
            est_seconds: 264.5,
            est_usd_cost: 0,
            depends_on: [],
            rationale: '469 stale pages on disk',
            status: 'remediable',
          },
        ],
        est_total_seconds: 659.5,
        est_total_usd_cost: 0,
        blocked: [],
      },
    });

    expect(summary.activeSource).toBe('gbrain');
    expect(summary.brainScore).toBe(37);
    expect(summary.defaultSource).toEqual({
      sourceId: 'default',
      pages: 1889,
      chunksTotal: 7800,
      chunksUnembedded: 7800,
      embeddingCoveragePct: 0,
    });
    expect(summary.unacknowledgedFailures).toBe(128);
    expect(summary.autopilot).toEqual({
      installed: false,
      running: false,
      waiting: 1,
    });
    expect(summary.maxReachableScore).toBe(73);
    expect(summary.recommendedCommands).toEqual([
      'gbrain embed --stale',
      'gbrain sync /Users/sawbeck/gbrain --no-embed',
    ]);
  });
});
