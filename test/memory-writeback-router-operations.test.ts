import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectMemoryReportInput } from '../src/commands/memory-report.ts';
import { createTokenAuthPrincipal } from '../src/core/auth-principal.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, parseOpArgs, type OperationContext } from '../src/core/operations.ts';
import { readCandidateContext } from '../src/core/services/inbox-lead-service.ts';
import { buildMemoryReviewReport } from '../src/core/services/memory-review-report-service.ts';
import { sweepExpiredWriteSessionFallbacks } from '../src/core/services/expired-write-session-fallback-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const sourceRefs = ['Source: User, direct message, 2026-05-10 12:00 KST'];
const currentHash = 'd'.repeat(64);

function pageContent(title: string, body: string): string {
  return ['---', 'type: concept', `title: ${title}`, '---', '', `${body} [Source: User, direct message, 2026-05-10 12:00 KST]`].join('\n');
}

async function withEngine<T>(run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-writeback-router-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function ctx(engine: OperationContext['engine'], dryRun = false, auth_principal?: OperationContext['auth_principal']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun,
    ...(auth_principal ? { auth_principal } : {}),
  };
}

describe('memory writeback router operation', () => {
  test('is registered as a mutating operation with CLI hint', () => {
    const op = operationsByName.route_memory_writeback;
    expect(op).toBeDefined();
    expect(op.mutating).toBe(true);
    expect(op.cliHints?.name).toBe('route-memory-writeback');
    expect(op.params.evidence_kind.enum).toContain('agent_inferred');
    expect(op.params.apply.type).toBe('boolean');
    expect(op.params.dry_run.type).toBe('boolean');
    expect(op.params.target_snapshot_hash.nullable).toBe(true);
  });

  test('CLI parser accepts dry-run for the router operation', () => {
    const warnings: string[] = [];
    const params = parseOpArgs(
      operationsByName.route_memory_writeback,
      [
        '--content',
        'The router should expose dry-run through CLI parsing.',
        '--evidence-kind',
        'direct_user_statement',
        '--source-refs',
        JSON.stringify(sourceRefs),
        '--apply',
        '--dry-run',
      ],
      { warn: (msg) => warnings.push(msg) },
    );

    expect(warnings).toEqual([]);
    expect(params.apply).toBe(true);
    expect(params.dry_run).toBe(true);
  });

  test('apply false does not read or mutate the engine', async () => {
    const engine = new Proxy(
      {},
      {
        get() {
          throw new Error('route_memory_writeback planning must not read the engine');
        },
      },
    ) as unknown as OperationContext['engine'];

    const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The router should create candidates for inferred claims.',
      evidence_kind: 'agent_inferred',
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      apply: false,
    })) as any;

    expect(result.decision).toBe('create_candidate');
    expect(result.applied).toBe(false);
    expect(result.created_candidate).toBeUndefined();
  });

  test('create_candidate routes apply by default instead of returning an unapplied plan', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The router should persist candidate-worthy claims by default.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
      })) as any;

      expect(result.decision).toBe('create_candidate');
      expect(result.applied).toBe(true);
      expect(result.writeback_governance_metadata).toMatchObject({
        apply_mode: 'candidate_created',
      });
      expect(result.created_candidate).toMatchObject({
        proposed_content: 'The router should persist candidate-worthy claims by default.',
        status: 'candidate',
      });

      const candidates = await engine.listMemoryCandidateEntries({ limit: 10 });
      expect(candidates.map((candidate) => candidate.id)).toContain(result.created_candidate.id);
    });
  });

  test('accepts source_refs as a CLI JSON array string', async () => {
    const engine = new Proxy(
      {},
      {
        get() {
          throw new Error('route_memory_writeback planning must not read the engine');
        },
      },
    ) as unknown as OperationContext['engine'];

    const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The router should accept source_refs from CLI JSON strings.',
      evidence_kind: 'direct_user_statement',
      source_refs: JSON.stringify(sourceRefs),
      apply: false,
    })) as any;

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input.source_refs).toEqual(sourceRefs);
  });

  test('canonical write routing carries target_snapshot_hash as put_page expected_content_hash', async () => {
    const engine = new Proxy(
      {},
      {
        get() {
          throw new Error('route_memory_writeback planning must not read the engine');
        },
      },
    ) as unknown as OperationContext['engine'];

    const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The user stated that canonical direct writes need optimistic concurrency.',
      evidence_kind: 'direct_user_statement',
      source_refs: sourceRefs,
      allow_canonical_write: true,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      target_snapshot_hash: currentHash,
      sensitivity: 'work',
    })) as any;

    expect(result.decision).toBe('canonical_write_allowed');
    expect(result.canonical_write_requirements.expected_content_hash).toBe(currentHash);
  });

  test('canonical apply creates an open write session for put_page handoff', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The user stated that canonical direct writes should use durable write sessions.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        target_snapshot_hash: currentHash,
        sensitivity: 'work',
        apply: true,
      })) as any;

      expect(result.decision).toBe('canonical_write_allowed');
      expect(result.applied).toBe(true);
      expect(result.route_decision_id).toMatch(/^route-memory-writeback:/);
      expect(result.write_session_id).toMatch(/^memory-write-session:/);
      expect(result.canonical_write_requirements.write_session_id).toBe(result.write_session_id);

      const sessions = await (engine as any).listMemoryWriteSessions({
        status: 'open',
        limit: 10,
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: result.write_session_id,
        route_decision_id: result.route_decision_id,
        status: 'open',
        target_slug: 'systems/mbrain',
        target_object_type: 'curated_note',
        expected_content_hash: currentHash,
        source_refs: sourceRefs,
        route_decision: 'canonical_write_allowed',
        intended_operation: 'put_page',
        scope_id: 'workspace:default',
      });
      expect(sessions[0].expires_at).toBeInstanceOf(Date);
    });
  });

  test('expired canonical write sessions fall back to a captured candidate once', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The user stated that expired write sessions should become reviewable candidates.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        target_snapshot_hash: currentHash,
        sensitivity: 'work',
        confidence_score: 0.91,
        importance_score: 0.82,
        apply: true,
      })) as any;

      const session = await (engine as any).getMemoryWriteSession(result.write_session_id);
      const sweep = await sweepExpiredWriteSessionFallbacks(engine, {
        scope_id: 'workspace:default',
        now: new Date(session.expires_at.getTime() + 1),
      });

      expect(sweep.swept).toEqual([
        expect.objectContaining({
          session_id: result.write_session_id,
          target_slug: 'systems/mbrain',
        }),
      ]);
      const candidate = await engine.getMemoryCandidateEntry(sweep.swept[0]!.candidate_id);
      expect(candidate).toMatchObject({
        status: 'captured',
        proposed_content: 'The user stated that expired write sessions should become reviewable candidates.',
        review_reason: 'expired_write_session_fallback',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        confidence_score: 0.91,
        importance_score: 0.82,
      });
      expect(candidate?.source_refs).toEqual(expect.arrayContaining([
        sourceRefs[0],
        `memory_write_session:${result.write_session_id}`,
      ]));
      const consumed = await (engine as any).getMemoryWriteSession(result.write_session_id);
      expect(consumed.status).toBe('expired');
      expect(consumed.status_reason).toBe('expired_write_session_fallback');

      const secondSweep = await sweepExpiredWriteSessionFallbacks(engine, {
        scope_id: 'workspace:default',
        now: new Date(session.expires_at.getTime() + 2),
      });
      expect(secondSweep.swept).toEqual([]);
    });
  });

  test('canonical dry-run apply previews without persisting a write session', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine, true), {
        content: 'The user stated that dry-run canonical routing should stay non-mutating.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        target_snapshot_hash: currentHash,
        sensitivity: 'work',
        apply: true,
      })) as any;

      expect(result.decision).toBe('canonical_write_allowed');
      expect(result.dry_run).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.write_session_id).toBeUndefined();
      expect(await (engine as any).listMemoryWriteSessions({ limit: 10 })).toEqual([]);
    });
  });

  test('secret sensitivity never creates a canonical write session', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'secret token abc123 must never be staged as canonical routed content.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/secret-write-session',
        target_snapshot_hash: null,
        sensitivity: 'secret',
        apply: true,
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.reasons).toContain('canonical_secret_not_allowed');
      expect(result.write_session_id).toBeUndefined();
      expect(result.canonical_write_requirements).toBeUndefined();
      expect(await (engine as any).listMemoryWriteSessions({ limit: 10 })).toEqual([]);
    });
  });

  test('canonical write session is bound to the routed content signal', async () => {
    await withEngine(async (engine) => {
      const routedContent = 'The user stated that write sessions are bound to this exact routed signal.';
      const routeResult = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: routedContent,
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/write-session-signal-binding',
        target_snapshot_hash: null,
        sensitivity: 'work',
        apply: true,
      })) as any;

      await expect(
        operationsByName.put_page.handler(ctx(engine), {
          slug: 'concepts/write-session-signal-binding',
          content: pageContent('Write Session Signal Binding', 'A different durable claim should not be authorized by this routed session.'),
          write_session_id: routeResult.write_session_id,
        }),
      ).rejects.toThrow(/routed content/i);

      expect(await engine.getPage('concepts/write-session-signal-binding')).toBeNull();
      const abandoned = await (engine as any).getMemoryWriteSession(routeResult.write_session_id);
      expect(abandoned).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('routed_content_mismatch'),
      });

      const secondRoute = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: routedContent,
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/write-session-signal-binding',
        target_snapshot_hash: null,
        sensitivity: 'work',
        apply: true,
      })) as any;
      await operationsByName.put_page.handler(ctx(engine), {
        slug: 'concepts/write-session-signal-binding',
        content: pageContent('Write Session Signal Binding', routedContent),
        write_session_id: secondRoute.write_session_id,
      });
      const page = await engine.getPage('concepts/write-session-signal-binding');
      expect(page?.compiled_truth).toContain(routedContent);
    });
  });

  test('canonical write session is bound to the issuing auth principal when present', async () => {
    await withEngine(async (engine) => {
      const routedContent = 'The routed session is bound to the issuing principal.';
      const principal = createTokenAuthPrincipal({
        tokenId: 'token-writer',
        tokenName: 'writer-token',
        surfaceProfile: 'stdio',
      });
      const routeResult = (await operationsByName.route_memory_writeback.handler(ctx(engine, false, principal), {
        content: routedContent,
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/write-session-principal-binding',
        target_snapshot_hash: null,
        sensitivity: 'work',
        apply: true,
      })) as any;

      await expect(
        operationsByName.put_page.handler(ctx(engine), {
          slug: 'concepts/write-session-principal-binding',
          content: pageContent('Write Session Principal Binding', routedContent),
          write_session_id: routeResult.write_session_id,
        }),
      ).rejects.toThrow(/auth principal/i);

      expect(await engine.getPage('concepts/write-session-principal-binding')).toBeNull();
      const abandoned = await (engine as any).getMemoryWriteSession(routeResult.write_session_id);
      expect(abandoned).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('auth_principal_mismatch'),
      });

      const httpPrincipal = createTokenAuthPrincipal({
        tokenId: 'token-writer',
        tokenName: 'writer-token',
        surfaceProfile: 'http_remote',
      });
      const edgeSurfacePrincipal = createTokenAuthPrincipal({
        tokenId: 'token-writer',
        tokenName: 'writer-token',
        surfaceProfile: 'edge_remote',
      });
      const surfaceRoute = (await operationsByName.route_memory_writeback.handler(ctx(engine, false, httpPrincipal), {
        content: routedContent,
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/write-session-principal-binding',
        target_snapshot_hash: null,
        sensitivity: 'work',
        apply: true,
      })) as any;
      await expect(
        operationsByName.put_page.handler(ctx(engine, false, edgeSurfacePrincipal), {
          slug: 'concepts/write-session-principal-binding',
          content: pageContent('Write Session Principal Binding', routedContent),
          write_session_id: surfaceRoute.write_session_id,
        }),
      ).rejects.toThrow(/auth principal/i);
      const surfaceRejected = await (engine as any).getMemoryWriteSession(surfaceRoute.write_session_id);
      expect(surfaceRejected).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('auth_principal_mismatch'),
      });

      const secondRoute = (await operationsByName.route_memory_writeback.handler(ctx(engine, false, principal), {
        content: routedContent,
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'concepts/write-session-principal-binding',
        target_snapshot_hash: null,
        sensitivity: 'work',
        apply: true,
      })) as any;
      await operationsByName.put_page.handler(ctx(engine, false, principal), {
        slug: 'concepts/write-session-principal-binding',
        content: pageContent('Write Session Principal Binding', routedContent),
        write_session_id: secondRoute.write_session_id,
      });
      const page = await engine.getPage('concepts/write-session-principal-binding');
      expect(page?.compiled_truth).toContain(routedContent);
    });
  });

  test('canonical write routing accepts null target_snapshot_hash only after the target is absent', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The user stated that absent targets can be created with a null precondition.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/new-mbrain-page',
        target_snapshot_hash: null,
        sensitivity: 'work',
      })) as any;

      expect(result.decision).toBe('canonical_write_allowed');
      expect(result.canonical_write_requirements.expected_content_hash).toBeNull();
    });
  });

  test('canonical write routing defers null target_snapshot_hash when the page exists', async () => {
    await withEngine(async (engine) => {
      await importFromContent(
        engine,
        'systems/mbrain',
        ['---', 'type: system', 'title: MBrain', '---', 'MBrain existing page. [Source: User, direct message, 2026-05-10 12:00 KST]'].join('\n'),
        { path: 'systems/mbrain.md' },
      );

      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The user stated that existing targets need a real target snapshot.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        target_snapshot_hash: null,
        sensitivity: 'work',
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.intended_operation).toBe('none');
      expect(result.reasons).toContain('canonical_target_exists_for_null_snapshot');
      expect(result.missing_requirements).toContain('target_snapshot_hash');
      expect(result.canonical_write_requirements).toBeUndefined();
    });
  });

  test('accepts corpus_lane as post-scope provenance metadata', async () => {
    const engine = new Proxy(
      {},
      {
        get() {
          throw new Error('route_memory_writeback planning must not read the engine');
        },
      },
    ) as unknown as OperationContext['engine'];

    const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The imported source contains lane-aware provenance.',
      source_kind: 'import',
      evidence_kind: 'source_extracted',
      source_refs: sourceRefs,
      corpus_lane: {
        lane_id: 'imports',
        source_record: 'source-record:meeting-42',
        import_origin: 'imports/meeting-42.md',
      },
      apply: false,
    })) as any;

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input.source_refs).toEqual(
      expect.arrayContaining(['corpus_lane:imports', 'source_record:source-record:meeting-42', 'import_origin:imports/meeting-42.md']),
    );
  });

  test('rejects blank corpus_lane fields', async () => {
    const engine = {} as unknown as OperationContext['engine'];

    await expect(
      operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The imported source contains invalid lane provenance.',
        source_kind: 'import',
        evidence_kind: 'source_extracted',
        source_refs: sourceRefs,
        corpus_lane: { lane_id: '   ' },
      }),
    ).rejects.toThrow(/corpus_lane\.lane_id/);
  });

  test('rejects invalid corpus_lane artifact kinds', async () => {
    const engine = {} as unknown as OperationContext['engine'];

    await expect(
      operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The imported source contains invalid lane provenance.',
        source_kind: 'import',
        evidence_kind: 'source_extracted',
        source_refs: sourceRefs,
        corpus_lane: { lane_id: 'imports', artifact_kind: 'not-real' },
      }),
    ).rejects.toThrow(/corpus_lane\.artifact_kind/);
  });

  test('rejects invalid target_snapshot_hash values', async () => {
    const engine = {} as unknown as OperationContext['engine'];

    await expect(
      operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'This target snapshot hash is invalid.',
        evidence_kind: 'direct_user_statement',
        source_refs: sourceRefs,
        allow_canonical_write: true,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        target_snapshot_hash: 'not-a-hash',
        sensitivity: 'work',
      }),
    ).rejects.toThrow(/target_snapshot_hash/);
  });

  test('rejects invalid source_refs JSON array strings', async () => {
    const engine = {} as unknown as OperationContext['engine'];

    await expect(
      operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'This source ref shape is invalid.',
        evidence_kind: 'direct_user_statement',
        source_refs: '[123]',
      }),
    ).rejects.toThrow(/source_refs/);
  });

  test('dry run ignores apply true and does not create a candidate', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine, true), {
        content: 'The router should keep dry-run planning non-mutating.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        apply: true,
      })) as any;

      expect(result.dry_run).toBe(true);
      expect(result.applied).toBe(false);
      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });

  test('apply true creates a candidate and status event with interaction id', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The router stores inferred durable claims as reviewable candidates.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        interaction_id: 'trace-router-1',
        apply: true,
      })) as any;

      expect(result.decision).toBe('create_candidate');
      expect(result.applied).toBe(true);
      expect(result.writeback_governance_metadata).toMatchObject({
        apply_mode: 'candidate_created',
      });
      expect(result.created_candidate).toMatchObject({
        candidate_type: 'fact',
        source_refs: sourceRefs,
        extraction_kind: 'inferred',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
      });
      expect(result.duplicate_review.decision).toBeDefined();

      const events = await engine.listMemoryCandidateStatusEvents({
        candidate_id: result.created_candidate.id,
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.interaction_id).toBe('trace-router-1');
    });
  });

  test('duplicate review failure does not leave behind a created candidate', async () => {
    await withEngine(async (engine) => {
      (engine as any).listPages = async () => {
        throw new Error('duplicate review failed');
      };

      await expect(
        operationsByName.route_memory_writeback.handler(ctx(engine), {
          content: 'The router should not create candidates when duplicate review fails.',
          evidence_kind: 'agent_inferred',
          source_refs: sourceRefs,
          target_object_type: 'curated_note',
          target_object_id: 'systems/mbrain',
          apply: true,
        }),
      ).rejects.toThrow('duplicate review failed');

      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });

  test('apply true annotates likely duplicate candidates instead of creating a blind twin', async () => {
    await withEngine(async (engine) => {
      await engine.createMemoryCandidateEntry({
        id: 'candidate-existing-duplicate-signal',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'Duplicate-aware routing keeps likely duplicate memory candidates reviewable.',
        source_refs: sourceRefs,
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.6,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'systems/other-memory',
      });

      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'Duplicate-aware routing keeps likely duplicate memory candidates reviewable.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        apply: true,
      })) as any;

      expect(result.decision).toBe('create_candidate');
      expect(result.duplicate_review.decision).toBe('likely_duplicate');
      expect(result.duplicate_annotation).toEqual({
        duplicate_of_candidate_id: 'candidate-existing-duplicate-signal',
      });
      expect(result.created_candidate.review_reason).toContain(
        'duplicate_of_candidate_id:candidate-existing-duplicate-signal',
      );
    });
  });

  test('apply true creates a reviewable open question when routing defers for missing provenance', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'This inferred claim has no source.',
        evidence_kind: 'agent_inferred',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        interaction_id: 'trace-router-defer',
        apply: true,
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.applied).toBe(true);
      expect(result.missing_requirements).toEqual(['source_refs']);
      expect(result.writeback_governance_metadata).toMatchObject({
        apply_mode: 'deferred_candidate_created',
      });
      expect(result.created_candidate).toMatchObject({
        candidate_type: 'open_question',
        proposed_content: 'This inferred claim has no source.',
        source_refs: [],
        extraction_kind: 'ambiguous',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        review_reason: 'route_memory_writeback_deferred:candidate_missing_provenance; missing_requirements:source_refs',
      });
      expect(result.duplicate_review.decision).toBeDefined();

      const candidates = await engine.listMemoryCandidateEntries({ limit: 10 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe(result.created_candidate.id);

      const events = await engine.listMemoryCandidateStatusEvents({
        candidate_id: result.created_candidate.id,
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.interaction_id).toBe('trace-router-defer');

      const reportInput = await collectMemoryReportInput(engine, 'workspace:default', 10, '2026-05-22T12:00:00.000Z');
      expect(reportInput.review_items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: result.created_candidate.id,
            review_type: 'deferred_candidate',
            summary: expect.stringContaining('open_question'),
          }),
        ]),
      );

      const report = buildMemoryReviewReport(reportInput);
      expect(JSON.stringify(report)).not.toContain('This inferred claim has no source.');
      for (const forbiddenKind of ['reject', 'stage_candidate', 'approve_candidate']) {
        expect(report.actions).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: forbiddenKind,
              target_id: result.created_candidate.id,
            }),
          ]),
        );
      }
    });
  });

  test('deferred import candidates do not treat lane-only metadata as provenance', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The imported source is missing source-record provenance.',
        source_kind: 'import',
        evidence_kind: 'source_extracted',
        corpus_lane: { lane_id: 'imports' },
        apply: true,
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.created_candidate).toMatchObject({
        status: 'captured',
        source_refs: [],
        review_reason: 'route_memory_writeback_deferred:candidate_missing_provenance; missing_requirements:source_refs',
      });
    });
  });

  test('deferred candidates do not treat explicit lane-only source refs as provenance', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The imported source has only lane metadata in source refs.',
        source_kind: 'import',
        evidence_kind: 'source_extracted',
        source_refs: ['corpus_lane:imports'],
        apply: true,
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.created_candidate).toMatchObject({
        status: 'captured',
        source_refs: [],
        review_reason: 'route_memory_writeback_deferred:candidate_missing_provenance; missing_requirements:source_refs',
      });

      const reportInput = await collectMemoryReportInput(engine, 'workspace:default', 10, '2026-05-22T12:00:00.000Z');
      expect(reportInput.candidate_debt).toMatchObject({
        missing_provenance_count: 1,
      });
    });
  });

  test('deferred personal targets remain personal-gated instead of work-visible', async () => {
    await withEngine(async (engine) => {
      const result = (await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The user may have a personal preference without explicit personal routing metadata.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'profile_memory',
        target_object_id: 'profile:default',
        apply: true,
      })) as any;

      expect(result.decision).toBe('defer');
      expect(result.created_candidate).toMatchObject({
        status: 'captured',
        sensitivity: 'personal',
      });

      const context = readCandidateContext({
        candidate: result.created_candidate,
        purpose: 'review',
        requested_scope: 'work',
        audit_reason: 'reviewing deferred candidate',
      });
      expect(context.access).toBe('denied');
      expect(context.reason_codes).toContain('personal_scope_required');
    });
  });

  test('duplicate review failure does not leave behind a deferred candidate', async () => {
    await withEngine(async (engine) => {
      (engine as any).listPages = async () => {
        throw new Error('duplicate review failed for deferred route');
      };

      await expect(
        operationsByName.route_memory_writeback.handler(ctx(engine), {
          content: 'This deferred claim should not persist when duplicate review fails.',
          evidence_kind: 'agent_inferred',
          apply: true,
        }),
      ).rejects.toThrow('duplicate review failed for deferred route');

      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });
});
