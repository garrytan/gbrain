import { describe, expect, test } from 'bun:test';

import {
  collectReceiptFromCommandOutput,
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
        source_id: 'source-alpha',
        tier: 'local_path',
        detail: '/Users/sawbeck/not-the-canonical-id',
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
          {
            id: 'no-integrations',
            priority: 2,
            title: 'Set Up Integrations',
            pitch: 'Integrations available.',
            command: 'gbrain integrations list',
            auto_fixable: false,
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
          {
            step: 3,
            id: 'extract.all',
            job: 'extract',
            params: {
              mode: 'all',
              dir: '/Users/sawbeck/gbrain',
            },
            idempotency_key: 'default:extract:5e632fac',
            severity: 'medium',
            est_seconds: 69.88,
            est_usd_cost: 0,
            depends_on: ['sync.repo'],
            rationale: 'Materialize link + timeline edges from fresh pages',
            status: 'remediable',
          },
        ],
        est_total_seconds: 659.5,
        est_total_usd_cost: 0,
        blocked: [],
      },
    });

    expect(summary.activeSource).toBe('source-alpha');
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
      'gbrain integrations list',
      'gbrain sync /Users/sawbeck/gbrain --no-embed',
      'gbrain extract all /Users/sawbeck/gbrain',
    ]);
  });

  test('collectReceiptFromCommandOutput preserves canonical source_id and complete command list from stubbed CLI output', async () => {
    const outputs = new Map<string, string>([
      ['sources current --json', JSON.stringify({
        source_id: 'default',
        tier: 'seed_default',
        detail: '/Users/sawbeck/gbrain',
        resolver_chain: ['flag', 'seed_default'],
      })],
      ['features --json', JSON.stringify({
        version: '0.41.36.0',
        scan_ts: '2026-06-03T21:26:56.760Z',
        brain_score: 37,
        recommendations: [
          { command: 'gbrain embed --stale' },
          { command: 'gbrain integrations list' },
        ],
      })],
      ['status --json', JSON.stringify({
        schema_version: 1,
        generated_at: '2026-06-03T21:26:57.674Z',
        mode: 'local',
        sync: {
          schema_version: 1,
          generated_at: '2026-06-03T21:26:57.720Z',
          sources: [
            {
              source_id: 'default',
              pages: 1889,
              chunks_total: 7800,
              chunks_unembedded: 7800,
              embedding_coverage_pct: 0,
            },
          ],
          unacknowledged_failures: 128,
        },
        queue: {
          waiting: 4,
        },
        autopilot: {
          installed: true,
          running: false,
        },
      })],
      ['doctor --remediation-plan --json', [
        '[doctor] planning remediation',
        JSON.stringify({
          schema_version: 2,
          brain_score_current: 37,
          brain_score_target: 90,
          max_reachable_score: 73,
          target_unreachable: true,
          plan: [
            {
              job: 'embed',
              params: { stale: true },
            },
            {
              job: 'sync',
              params: { repoPath: '/Users/sawbeck/gbrain', noEmbed: true },
            },
            {
              job: 'extract',
              params: { mode: 'all', dir: '/Users/sawbeck/gbrain' },
            },
          ],
          blocked: [],
        }),
      ].join('\n')],
    ]);

    const summary = await collectReceiptFromCommandOutput((args) => {
      const key = args.join(' ');
      const output = outputs.get(key);
      if (!output) {
        throw new Error(`Unexpected command: ${key}`);
      }
      return output;
    });

    expect(summary).toEqual({
      activeSource: 'default',
      brainScore: 37,
      defaultSource: {
        sourceId: 'default',
        pages: 1889,
        chunksTotal: 7800,
        chunksUnembedded: 7800,
        embeddingCoveragePct: 0,
      },
      unacknowledgedFailures: 128,
      autopilot: {
        installed: true,
        running: false,
        waiting: 4,
      },
      maxReachableScore: 73,
      recommendedCommands: [
        'gbrain embed --stale',
        'gbrain integrations list',
        'gbrain sync /Users/sawbeck/gbrain --no-embed',
        'gbrain extract all /Users/sawbeck/gbrain',
      ],
    });
  });
});
