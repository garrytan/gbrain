import { readTaskRelations } from '../product/tasks/relations.ts';
import { getAdminKnowledgeGraphEdge } from './admin-knowledge-graph.ts';

import express from 'express';
import { taskRunSummary } from '../product/tasks/progress-adapter.ts';
import type { Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { extname, join as joinPath } from 'node:path';
import { safeHexEqual } from '../core/timing-safe.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider, legacyAccessTokenScopes, legacyAccessTokenSourceScope, validateTokenEndpointAuthMethod } from '../core/oauth-provider.ts';
import type { SqlQuery } from '../core/oauth-provider.ts';
import { hasScope, ALLOWED_SCOPES_LIST, normalizeScopesInput } from '../core/scope.ts';
import { summarizeMcpParams, dispatchToolCall } from '../mcp/dispatch.ts';
import { paramDefToSchema } from '../mcp/tool-defs.ts';
import { getBrainHotMemoryMeta } from '../core/facts/meta-hook.ts';
import { loadConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { brainDirFromConfig } from '../core/system-skill-assets.ts';
import { ensureDreamOutputDirectory, resolveDreamOutputRoot } from '../core/cycle/dream-output.ts';
import { inspectPgliteOwner, terminatePgliteOwner } from '../core/pglite-owner-control.ts';
import { buildError, serializeError } from '../core/errors.ts';
import { assessDestructiveImpact, softDeleteSource, restoreSource } from '../core/destructive-guard.ts';
import { deleteLockRow } from '../core/db-lock.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';
import { sqlQueryForEngine, executeRawJsonb } from '../core/sql-query.ts';
import { resolveMainSourceId } from '../core/source-resolver.ts';
import { ensureSourceLocalPath } from '../core/sources-ops.ts';
import { isImageFilePath, isMarkdownFilePath, isOfficeFilePath } from '../core/sync.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import {
  DEFAULT_ADMIN_DREAM_SCHEDULE_TIME,
  adminDreamScheduleDateKey,
  isAdminDreamScheduleDue,
  isValidAdminDreamScheduleTime,
  type AdminDreamScheduleSettings,
} from './admin-dream-schedule.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import {
  executePreview,
  getAdminBrainOverview,
  getAdminBrainFact,
  getAdminBrainPageDetail,
  getAdminBrainPageChunks,
  getAdminKnowledgeGraphGlobal,
  getAdminKnowledgeGraphIsolated,
  getAdminKnowledgeGraphMissingLinks,
  getAdminKnowledgeGraphMeta,
  getAdminKnowledgeGraphNeighborhood,
  getAdminDreamOverview,
  getSupervisorStatus,
  getAdminLlmStatus,
  getRun,
  cancelRun,
  listAdminBrainFacts,
  listAdminBrainPages,
  listRuns,
  PgliteRunCoordinator,
  previewIntent,
  resolveCliEntry,
  startActionRun,
  startCaptureRun,
  startMarkdownExportRun,
  startSourceAddRun,
  startSourceGitRun,
  startThinkRun,
  sanitizeOutput,
  searchAdminKnowledgeGraphPages,
} from './admin-console.ts';
import { runAdminKnowledgeSearch } from './admin-knowledge-search.ts';
import { buildChecks as buildDoctorChecks } from './doctor.ts';
import { waitForAdminSupervisorReady } from './admin-supervisor.ts';
import {
  buildChatGptTunnelProfile,
  CHATGPT_TUNNEL_TOKEN_NAME,
  chatGptTunnelPaths,
  defaultTunnelClientBinary,
  detectTunnelHttpProxy,
  getChatGptTunnelStatus,
  runTunnelDoctor,
  startTunnelClient,
  stopTunnelClient,
  writeChatGptTunnelProfile,
  writePrivateFile,
} from '../core/chatgpt-tunnel.ts';
import type { RunHooks } from './natural-lang/executor.ts';
import { normalizeAdminDreamRequest } from './admin-dream-policy.ts';
import {
  ADMIN_DOCS_EMPTY_MARKDOWN,
  ADMIN_DREAM_SCHEDULE_CHECK_MS,
  ADMIN_DREAM_SCHEDULE_ENABLED_KEY,
  ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY,
  ADMIN_DREAM_SCHEDULE_TIME_KEY,
  ADMIN_UPLOAD_MAX_BYTES,
  classifyAdminUploadFilename,
  firstQueryValue,
  loadAdminReadmeMarkdown,
  normalizeAdminUploadFilename,
  queryFlag,
  removeAdminUploadTempDir,
} from './pmbrain-admin-support.ts';
import { sendAdminContract } from './admin-response-contract.ts';
import {
  BrainOverviewResponseSchema,
  BrainPageChunksResponseSchema,
  BrainPageDetailResponseSchema,
  BrainFactDetailResponseSchema,
  BrainFactsResponseSchema,
  MemoryWritebackStatusSchema,
  MemoryWritebackUpdateRequestSchema,
  BrainPagesResponseSchema,
  KnowledgeGraphMetaResponseSchema,
  KnowledgeGraphGlobalResponseSchema,
  KnowledgeGraphNeighborhoodResponseSchema,
  KnowledgeGraphMissingLinksResponseSchema,
  KnowledgeGraphSearchResponseSchema,
  DreamOverviewResponseSchema,
  DreamRunResponseSchema,
  DreamScheduleResponseSchema,
  DreamSettingsResponseSchema,
  EntityCaptureBudgetResponseSchema,
  GenerativeUsageResponseSchema,
  ImportRunResponseSchema,
  ImportRunRequestSchema,
  ImportUploadRunResponseSchema,
  LlmStatusResponseSchema,
  RunAcceptedResponseSchema,
  SetDefaultSourceResponseSchema,
  SourceAddResponseSchema,
  AdvisorAdminResponseSchema,
  AdvisorApplyRequestSchema,
  AdvisorApplyResponseSchema,
  ChronicleHideRequestSchema,
  ConnectorAuthRequestSchema,
  ConnectorLogoutRequestSchema,
  ConnectorSyncRequestSchema,
  EntityIdentityLinkRequestSchema,
  GoogleConnectEnvelopeSchema,
  GoogleConnectRequestSchema,
  GoogleSourceAddRequestSchema,
  PeopleMergeRequestSchema,
  PeopleRejectRequestSchema,
  PeopleUnlinkRequestSchema,
  ProductSurfacePayloadSchema,
  WaitingCloseRequestSchema,
  WaitingScanRequestSchema,
} from '../../shared/contracts/index.ts';
import { applyAdminAdvisorFinding, getAdminAdvisorReport } from './admin-advisor.ts';
import {
  addAdminGoogleSource,
  getAdminGoogleStatus,
  localDateKey,
  runAdminProductOp,
} from './admin-product-surfaces.ts';
import {
  authConnector,
  chronicleStatus,
  connectGoogleAndLink,
  enableChronicle,
  hideChronicleEvent,
  listPeopleWorkspace,
  logoutConnector,
  mergePeople,
  organizeChronicleHistory,
  peopleCard,
  presentChronicleRows,
  presentConnectors,
  presentWaiting,
  rejectPeoplePair,
  scanWaiting,
  setChronicleEnabled,
  setConnectorAutoSync,
  setWaitingAutomation,
  unlinkPeopleMember,
  waitingAutomationStatus,
} from './admin-daily-product.ts';
import { OperationError } from '../core/operation-error.ts';
import { SourceOpError } from '../core/sources-ops.ts';
import { registerWorkbenchRoutes } from '../product/workbench/routes.ts';
import { reloadLiveGateway } from '../core/ai/reload-live-gateway.ts';
import { ProductTaskRuntime } from '../product/tasks/runtime.ts';

export interface PmbrainAdminRouteOptions {
  app: express.Express;
  engine: BrainEngine;
  config: GBrainConfig;
  requireAdmin: express.RequestHandler;
  runHooks?: RunHooks;
  getPgliteBusy: () => boolean;
  getPgliteConnected?: () => boolean;
  reconnectPglite?: () => Promise<void>;
  ensureAdminWorkerStarted: () => Promise<unknown>;
  productTasks: ProductTaskRuntime;
}

export function registerPmbrainAdminRoutes(options: PmbrainAdminRouteOptions): {
  checkScheduledDream: (now?: Date) => Promise<void>;
} {
  const {
    app,
    engine,
    config,
    requireAdmin,
    runHooks,
    getPgliteBusy,
    getPgliteConnected,
    reconnectPglite,
    ensureAdminWorkerStarted,
  } = options;
  registerWorkbenchRoutes(app, requireAdmin, engine, config, { databaseAvailable: () => !getPgliteBusy() });
  const productTasks = options.productTasks;
  const readRuns = async () => [...(getPgliteBusy() ? productTasks.cachedRuns() : await productTasks.listRuns()), ...listRuns()];
  const readRun = async (id: string) => (getPgliteBusy() ? productTasks.cachedRuns().find(run => run.id === id) : await productTasks.getRun(id)) ?? getRun(id);
  app.post('/admin/api/gateway/reload', requireAdmin, async (_req: Request, res: Response) => {
    try {
      await reloadLiveGateway(engine);
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });
  app.get('/admin/api/task-center', requireAdmin, async (req: Request, res: Response) => {
    const runs = await readRuns();
    const hasActiveRun = runs.some(run => run.status === 'queued' || run.status === 'running');
    let queue: unknown = null;
    if (!getPgliteBusy() && !hasActiveRun) {
      try {
        const { readSnapshot } = await import('./jobs-watch.ts');
        queue = await readSnapshot(engine);
      } catch {
        queue = null;
      }
    }
    // A live queued/running Admin task is the expected PGLite owner. Only
    // inspect the owner for recovery when there is no actual task record;
    // disconnected state alone must not turn a normal maintenance run into a
    // misleading "残留占用进程" card.
    const pgliteOwner = config.engine === 'pglite' && config.database_path && !hasActiveRun && options.getPgliteConnected?.()!==true
      ? await inspectPgliteOwner(config.database_path, {
          allowTerminate: true,
        })
      : null;
    const { readEmbeddingRebuildState, clearEmbeddingRebuildState } = await import('../core/embedding-rebuild-state.ts');
    const hasActiveEmbed = runs.some(run => run.kind === 'embed_stale' && (run.status === 'queued' || run.status === 'running'));
    let embeddingRebuild = readEmbeddingRebuildState(loadConfig() ?? config);
    if (embeddingRebuild?.status === 'running' && !hasActiveEmbed) {
      clearEmbeddingRebuildState();
      embeddingRebuild = null;
    }
    res.json({
      mode: config.engine === 'pglite' ? 'pglite' : 'postgres',
      pglite_busy: getPgliteBusy(),
      pglite_owner: pgliteOwner,
      rows: req.query.summary === '1' ? runs.map(taskRunSummary) : runs,
      queue,
      embedding_rebuild: embeddingRebuild,
      server_time: new Date().toISOString(),
    });
  });

  app.post('/admin/api/pglite-owner/terminate', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    if (config.engine !== 'pglite' || !config.database_path) {
      res.status(400).json({ error: 'pglite_owner_control_unavailable' });
      return;
    }
    if(options.getPgliteConnected?.()===true){
      res.status(409).json({error:'pglite_owner_is_current',message:'当前服务正在正常持有数据库，不能结束正常的数据库执行进程。'});return;
    }
    const pgliteDisconnected = getPgliteConnected?.() === false;
    if (getPgliteBusy() && !pgliteDisconnected) {
      res.status(423).json({ error: 'PGLite 正在执行后台任务，请使用任务卡片中的安全取消。', code: 'pglite_busy' });
      return;
    }
    const pid = Number(req.body?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      res.status(400).json({ error: 'pglite_owner_pid_invalid' });
      return;
    }
    try {
      const owner = await terminatePgliteOwner(config.database_path, pid);
      let reconnected = false;
      let reconnectError: string | null = null;
      if (reconnectPglite) {
        try {
          await reconnectPglite();
          reconnected = true;
        } catch (error) {
          reconnectError = error instanceof Error ? error.message : String(error);
        }
      }
      const latestOwner = await inspectPgliteOwner(config.database_path, {
        allowTerminate: false,
      });
      res.json({
        pglite_owner: latestOwner.state === 'current' ? latestOwner : owner,
        reconnected,
        reconnect_error: reconnectError,
      });
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : String(error),
        code: 'pglite_owner_terminate_failed',
      });
    }
  });

  app.get('/admin/api/brain/overview', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainOverviewResponseSchema, await getAdminBrainOverview(engine, config, VERSION, {
        inspectSourceGit: req.query.source_git_status === '1',
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'overview_failed' });
    }
  });

  app.get('/admin/api/search-index-health', requireAdmin, async (_req: Request, res: Response) => {
    if (engine.kind !== 'pglite') {
      res.json({ ok: true, engine: engine.kind, repairable: false });
      return;
    }
    if (getPgliteBusy()) {
      res.json({ ok: true, engine: 'pglite', repairable: true, busy: true });
      return;
    }
    try {
      const { probeGinSearch } = await import('../core/pglite-gin-repair.ts');
      await probeGinSearch(engine);
      res.json({ ok: true, engine: 'pglite', repairable: true });
    } catch (e) {
      const {
        GIN_REPAIR_DB_UNUSABLE_MESSAGE,
        isDatabaseUnusableError,
      } = await import('../core/pglite-gin-repair.ts');
      if (isDatabaseUnusableError(e)) {
        res.json({
          ok: false,
          engine: 'pglite',
          repairable: false,
          message: GIN_REPAIR_DB_UNUSABLE_MESSAGE,
        });
        return;
      }
      res.json({
        ok: false,
        engine: 'pglite',
        repairable: true,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post('/admin/api/search-index-repair', requireAdmin, async (_req: Request, res: Response) => {
    if (engine.kind !== 'pglite') {
      res.status(400).json({ error: '当前数据库不需要重建搜索索引。' });
      return;
    }
    if (getPgliteBusy()) {
      res.status(423).json({ error: '正在执行其他任务，请稍后再重建搜索索引。', code: 'pglite_busy' });
      return;
    }
    try {
      const { repairPgliteGinIndexes } = await import('../core/pglite-gin-repair.ts');
      const result = await repairPgliteGinIndexes(engine);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'search_index_repair_failed' });
    }
  });

  app.get('/admin/api/advisor', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, AdvisorAdminResponseSchema, await getAdminAdvisorReport(engine, loadConfig() ?? config));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'advisor_failed' });
    }
  });

  app.post('/admin/api/advisor/apply', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const input = AdvisorApplyRequestSchema.parse(req.body);
      sendAdminContract(
        res,
        AdvisorApplyResponseSchema,
        await applyAdminAdvisorFinding(engine, loadConfig() ?? config, input.dispatch_id, process.cwd(), runHooks),
      );
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'advisor_apply_failed' });
    }
  });

  const sendProductOpError = (res: Response, e: unknown, fallback: string) => {
    if (e instanceof OperationError) {
      res.status(e.code === 'permission_denied' ? 403 : 400).json({ error: e.message, code: e.code });
      return;
    }
    if (e instanceof SourceOpError) {
      res.status(400).json({ error: e.message, code: e.code });
      return;
    }
    res.status(400).json({ error: e instanceof Error ? e.message : fallback });
  };

  app.get('/admin/api/connectors', requireAdmin, async (req: Request, res: Response) => {
    try {
      const provider = firstQueryValue(req.query.provider);
      if (provider) {
        sendAdminContract(
          res,
          ProductSurfacePayloadSchema,
          await runAdminProductOp(engine, 'connectors_status', { provider }),
        );
        return;
      }
      sendAdminContract(res, ProductSurfacePayloadSchema, await presentConnectors(engine));
    } catch (e) {
      sendProductOpError(res, e, 'connectors_status_failed');
    }
  });

  app.post('/admin/api/connectors/auth', requireAdmin, express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    try {
      const input = ConnectorAuthRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, await authConnector(input));
    } catch (e) {
      sendProductOpError(res, e, 'connector_auth_failed');
    }
  });

  app.post('/admin/api/connectors/logout', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const input = ConnectorLogoutRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, logoutConnector(input.provider));
    } catch (e) {
      sendProductOpError(res, e, 'connector_logout_failed');
    }
  });

  app.post('/admin/api/connectors/sync', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      const input = ConnectorSyncRequestSchema.parse(req.body);
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await runAdminProductOp(engine, 'connector_sync', {
          provider: input.provider,
          ...(input.full === true ? { full: true } : {}),
          ...(input.dry_run === true ? { dry_run: true } : {}),
        }),
      );
    } catch (e) {
      sendProductOpError(res, e, 'connector_sync_failed');
    }
  });

  app.get('/admin/api/waiting', requireAdmin, async (req: Request, res: Response) => {
    try {
      const limitRaw = firstQueryValue(req.query.limit);
      const limit = limitRaw ? Number(limitRaw) : 20;
      const payload = await runAdminProductOp(engine, 'open_loops', {
        group_by: 'counterparty',
        include_context: true,
        all_sources: true,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      sendAdminContract(res, ProductSurfacePayloadSchema, await presentWaiting(engine, payload));
    } catch (e) {
      sendProductOpError(res, e, 'waiting_failed');
    }
  });

  app.post('/admin/api/waiting/scan', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const input = WaitingScanRequestSchema.parse(req.body ?? {});
      const selected = input.lanes ?? ['gmail', 'meeting', 'conversation'];
      const gmailRun = selected.includes('gmail')
        ? await productTasks.submitSync()
        : null;
      const result = await scanWaiting(engine, selected);
      sendAdminContract(res, ProductSurfacePayloadSchema, {
        ...result,
        ...(gmailRun ? { gmail_run_id: gmailRun.id, gmail_status: gmailRun.status } : {}),
      });
    } catch (e) {
      sendProductOpError(res, e, 'waiting_scan_failed');
    }
  });

  app.get('/admin/api/waiting/settings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, ProductSurfacePayloadSchema, await waitingAutomationStatus(engine));
    } catch (e) {
      sendProductOpError(res, e, 'waiting_settings_failed');
    }
  });

  app.post('/admin/api/waiting/settings', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      if (typeof body.enabled !== 'boolean') {
        throw new OperationError('invalid_params', '请指定是否自动识别待办');
      }
      sendAdminContract(res, ProductSurfacePayloadSchema, await setWaitingAutomation(engine, body.enabled));
    } catch (e) {
      sendProductOpError(res, e, 'waiting_settings_failed');
    }
  });

  app.post('/admin/api/connectors/auto-sync', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      if (typeof body.provider !== 'string' || typeof body.enabled !== 'boolean') {
        throw new OperationError('invalid_params', '请选择连接并指定是否自动同步');
      }
      sendAdminContract(res, ProductSurfacePayloadSchema, await setConnectorAutoSync(engine, body.provider, body.enabled));
    } catch (e) {
      sendProductOpError(res, e, 'connector_auto_sync_failed');
    }
  });

  app.post('/admin/api/waiting/close', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const input = WaitingCloseRequestSchema.parse(req.body);
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await runAdminProductOp(engine, 'loops_close', {
          id: input.id,
          status: input.status,
          ...(input.note ? { note: input.note } : {}),
        }),
      );
    } catch (e) {
      sendProductOpError(res, e, 'waiting_close_failed');
    }
  });

  app.get('/admin/api/chronicle/day', requireAdmin, async (req: Request, res: Response) => {
    try {
      const date = firstQueryValue(req.query.date) || localDateKey();
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await presentChronicleRows(engine, await runAdminProductOp(engine, 'chronicle_day', { date })),
      );
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_day_failed');
    }
  });

  app.get('/admin/api/chronicle/on-this-day', requireAdmin, async (req: Request, res: Response) => {
    try {
      const date = firstQueryValue(req.query.date);
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await presentChronicleRows(engine, await runAdminProductOp(engine, 'chronicle_on_this_day', date ? { date } : {})),
      );
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_on_this_day_failed');
    }
  });

  app.get('/admin/api/chronicle/status', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, ProductSurfacePayloadSchema, await chronicleStatus(engine));
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_status_failed');
    }
  });

  app.post('/admin/api/chronicle/enable', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, ProductSurfacePayloadSchema, await enableChronicle(engine));
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_enable_failed');
    }
  });

  app.post('/admin/api/chronicle/settings', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      if (typeof body.enabled !== 'boolean') {
        throw new OperationError('invalid_params', '请指定是否自动生成时间线');
      }
      sendAdminContract(res, ProductSurfacePayloadSchema, await setChronicleEnabled(engine, body.enabled));
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_settings_failed');
    }
  });

  app.post('/admin/api/chronicle/history', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await organizeChronicleHistory(engine) as Record<string, unknown>;
      const enqueued = Number(result.enqueued ?? 0);
      const worker = enqueued > 0 ? await ensureAdminWorkerStarted() : null;
      sendAdminContract(res, ProductSurfacePayloadSchema, { ...result, worker });
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_history_failed');
    }
  });

  app.post('/admin/api/chronicle/hide', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const input = ChronicleHideRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, await hideChronicleEvent(engine, input.slug));
    } catch (e) {
      sendProductOpError(res, e, 'chronicle_hide_failed');
    }
  });

  app.get('/admin/api/ontology', requireAdmin, async (req: Request, res: Response) => {
    try {
      const entity = firstQueryValue(req.query.entity);
      if (!entity) {
        res.status(400).json({ error: 'entity_required' });
        return;
      }
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await runAdminProductOp(engine, 'ontology_get', { entity }),
      );
    } catch (e) {
      sendProductOpError(res, e, 'ontology_failed');
    }
  });

  app.get('/admin/api/entity-identity', requireAdmin, async (req: Request, res: Response) => {
    try {
      const entityId = firstQueryValue(req.query.entity_id);
      const slug = firstQueryValue(req.query.slug);
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await runAdminProductOp(engine, 'entity_identity_list', {
          ...(entityId ? { entity_id: entityId } : {}),
          ...(slug ? { slug } : {}),
        }),
      );
    } catch (e) {
      sendProductOpError(res, e, 'entity_identity_list_failed');
    }
  });

  app.post('/admin/api/entity-identity/link', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      const input = EntityIdentityLinkRequestSchema.parse(req.body);
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await runAdminProductOp(engine, 'entity_identity_link', {
          entity_id: input.entity_id,
          slug: input.slug,
          source_id: input.source_id,
          ...(input.canonical === true ? { canonical: true } : {}),
        }),
      );
    } catch (e) {
      sendProductOpError(res, e, 'entity_identity_link_failed');
    }
  });

  app.get('/admin/api/people', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(
        res,
        ProductSurfacePayloadSchema,
        await listPeopleWorkspace(engine, firstQueryValue(req.query.q) ?? ''),
      );
    } catch (e) {
      sendProductOpError(res, e, 'people_list_failed');
    }
  });

  app.get('/admin/api/people/card', requireAdmin, async (req: Request, res: Response) => {
    try {
      const entityId = firstQueryValue(req.query.entity_id);
      if (!entityId) {
        res.status(400).json({ error: 'entity_required' });
        return;
      }
      sendAdminContract(res, ProductSurfacePayloadSchema, await peopleCard(engine, entityId));
    } catch (e) {
      sendProductOpError(res, e, 'people_card_failed');
    }
  });

  app.post('/admin/api/people/merge', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const input = PeopleMergeRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, await mergePeople(engine, input.members));
    } catch (e) {
      sendProductOpError(res, e, 'people_merge_failed');
    }
  });

  app.post('/admin/api/people/reject', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      const input = PeopleRejectRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, await rejectPeoplePair(engine, input.left, input.right));
    } catch (e) {
      sendProductOpError(res, e, 'people_reject_failed');
    }
  });

  app.post('/admin/api/people/unlink', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      const input = PeopleUnlinkRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, ProductSurfacePayloadSchema, await unlinkPeopleMember(engine, input));
    } catch (e) {
      sendProductOpError(res, e, 'people_unlink_failed');
    }
  });

  app.get('/admin/api/google/status', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, ProductSurfacePayloadSchema, await getAdminGoogleStatus(engine));
    } catch (e) {
      sendProductOpError(res, e, 'google_status_failed');
    }
  });

  app.post('/admin/api/google/connect', requireAdmin, express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    try {
      const input = GoogleConnectRequestSchema.parse(req.body ?? {});
      sendAdminContract(res, GoogleConnectEnvelopeSchema, await connectGoogleAndLink(engine, input));
    } catch (e) {
      sendProductOpError(res, e, 'google_connect_failed');
    }
  });

  app.post('/admin/api/google/source', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    try {
      const input = GoogleSourceAddRequestSchema.parse(req.body);
      sendAdminContract(res, ProductSurfacePayloadSchema, await addAdminGoogleSource(engine, input));
    } catch (e) {
      sendProductOpError(res, e, 'google_source_failed');
    }
  });

  app.get('/admin/api/theme', requireAdmin, (_req: Request, res: Response) => {
    const source = loadConfig()?.desktop?.theme;
    res.json({ source: source === 'light' || source === 'dark' ? source : 'system' });
  });

  app.get('/admin/api/desktop-state', requireAdmin, (_req: Request, res: Response) => {
    const desktop = loadConfig()?.desktop;
    const networkMode = desktop?.network_mode === 'shared' ? 'shared' : 'local';
    const configuredSharedIp = typeof desktop?.shared_ip === 'string' ? desktop.shared_ip.trim() : '';
    const sharedIp = isIP(configuredSharedIp) === 4 ? configuredSharedIp : undefined;
    res.json({ networkMode, sharedIp });
  });

  app.post('/admin/api/sources/default', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
    const localPath = req.body?.localPath === undefined
      ? undefined
      : typeof req.body.localPath === 'string' ? req.body.localPath.trim() : '';
    if (!sourceId) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (localPath === '') {
      res.status(400).json({ error: 'local_path_required' });
      return;
    }
    try {
      const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM sources WHERE id = $1 LIMIT 1`,
        [sourceId],
      );
      const source = rows[0];
      if (!source) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      if (source.archived) {
        res.status(400).json({ error: 'archived_source_cannot_be_main' });
        return;
      }
      if (localPath !== undefined) await ensureSourceLocalPath(engine, sourceId, localPath);
      await engine.setConfig('sources.default', sourceId);
      sendAdminContract(res, SetDefaultSourceResponseSchema, { sourceId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'set_default_source_failed' });
    }
  });

  // Desktop compatibility repair: attach a path to an existing DB source
  // without changing the brain-level default. Source selection is an
  // explicit setup action; historical path repair must not re-run it.
  app.post('/admin/api/sources/local-path', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : '';
    const localPath = typeof req.body?.localPath === 'string' ? req.body.localPath.trim() : '';
    if (!sourceId) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (!localPath) {
      res.status(400).json({ error: 'local_path_required' });
      return;
    }
    try {
      const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM sources WHERE id = $1 LIMIT 1`,
        [sourceId],
      );
      const source = rows[0];
      if (!source) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      if (source.archived) {
        res.status(400).json({ error: 'archived_source_cannot_be_repaired' });
        return;
      }
      await ensureSourceLocalPath(engine, sourceId, localPath);
      sendAdminContract(res, SetDefaultSourceResponseSchema, { sourceId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'repair_source_local_path_failed' });
    }
  });

  const dreamScheduleView = async (overrides?: { enabled?: boolean; time?: string; lastStartedDate?: string | null }) => {
    const [storedEnabled, storedTime, storedLastStartedDate] = await Promise.all([
      engine.getConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY),
      engine.getConfig(ADMIN_DREAM_SCHEDULE_TIME_KEY),
      engine.getConfig(ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY),
    ]);
    const storedTimeValue = storedTime?.trim() ?? '';
    return {
      enabled: overrides?.enabled ?? storedEnabled === 'true',
      time: overrides?.time ?? (isValidAdminDreamScheduleTime(storedTimeValue)
        ? storedTimeValue
        : DEFAULT_ADMIN_DREAM_SCHEDULE_TIME),
      lastStartedDate: overrides?.lastStartedDate ?? (storedLastStartedDate?.trim() || null),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    };
  };

  let scheduledDreamStarting = false;
  let scheduledDreamRetryAfter = 0;
  const checkScheduledDream = async (now = new Date()) => {
    if (
      scheduledDreamStarting
      || Date.now() < scheduledDreamRetryAfter
      || (config.engine === 'pglite' && (getPgliteBusy() || getPgliteConnected?.() === false))
    ) return;
    let settings: AdminDreamScheduleSettings;
    try {
      settings = await dreamScheduleView();
    } catch (e) {
      console.error('[admin dream schedule] Unable to read settings:', e instanceof Error ? e.message : e);
      return;
    }
    if (!isAdminDreamScheduleDue(settings, now)) return;
    const hasActiveDream = (await readRuns()).some(run => (
      run.kind.startsWith('dream_') && (run.status === 'running' || run.status === 'queued')
    ));
    if (hasActiveDream) return;

    scheduledDreamStarting = true;
    const today = adminDreamScheduleDateKey(now);
    try {
      // Same entry as Admin「快速维护」: dream --preset quick. No parallel organize pipeline.
      // Unattended runs keep a 120-minute safety timeout; manual quick has no default timeout.
      await engine.setConfig(ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY, today);
      const run = await productTasks.submitDream({
        preset: 'quick',
        allSources: true,
        timeoutMs: 120 * 60 * 1000,
      }, 'scheduled');
      if (run.status !== 'running' && run.status !== 'queued') {
        throw new Error(run.error || `dream_schedule_start_${run.status}`);
      }
      console.error(`[admin dream schedule] Started quick organization for ${today} at ${settings.time} (run ${run.id}).`);
    } catch (e) {
      scheduledDreamRetryAfter = Date.now() + 5 * 60 * 1000;
      try {
        await engine.setConfig(
          ADMIN_DREAM_SCHEDULE_LAST_STARTED_DATE_KEY,
          settings.lastStartedDate ?? '',
        );
      } catch {
        // A PGLite child may temporarily own the engine; the next service start can retry if needed.
      }
      console.error('[admin dream schedule] Automatic start failed:', e instanceof Error ? e.message : e);
    } finally {
      scheduledDreamStarting = false;
    }
  };

  app.get('/admin/api/dream/schedule', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, DreamScheduleResponseSchema, await dreamScheduleView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_schedule_settings_failed' });
    }
  });

  app.post('/admin/api/dream/schedule', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    const time = typeof req.body?.time === 'string' ? req.body.time.trim() : '';
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'dream_schedule_enabled_must_be_boolean' });
      return;
    }
    if (!isValidAdminDreamScheduleTime(time)) {
      res.status(400).json({ error: 'dream_schedule_time_must_be_hh_mm' });
      return;
    }
    try {
      await Promise.all([
        engine.setConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY, enabled ? 'true' : 'false'),
        engine.setConfig(ADMIN_DREAM_SCHEDULE_TIME_KEY, time),
      ]);
      const view = await dreamScheduleView({ enabled, time });
      sendAdminContract(res, DreamScheduleResponseSchema, view);
      if (enabled) {
        const immediateCheck = setTimeout(() => void checkScheduledDream(), 0);
        immediateCheck.unref?.();
      }
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_dream_schedule_failed' });
    }
  });

  const entityCaptureBudgetView = async () => {
    const { readEntityCaptureCostCap, readTokenCap, DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS, DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS } = await import('../core/cycle/entity-capture-budget.ts');
    const [cap, input, output] = await Promise.all([
      engine.getConfig('dream.entity_capture.cost_cap_cny'),
      engine.getConfig('dream.entity_capture.max_input_tokens'),
      engine.getConfig('dream.entity_capture.max_output_tokens'),
    ]);
    return {
      costCapCny: readEntityCaptureCostCap(cap),
      maxInputTokens: readTokenCap(input, DEFAULT_ENTITY_CAPTURE_MAX_INPUT_TOKENS),
      maxOutputTokens: readTokenCap(output, DEFAULT_ENTITY_CAPTURE_MAX_OUTPUT_TOKENS),
    };
  };

  app.get('/admin/api/dream/entity-capture-budget', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, EntityCaptureBudgetResponseSchema, await entityCaptureBudgetView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'entity_capture_budget_failed' });
    }
  });

  app.post('/admin/api/dream/entity-capture-budget', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const { parseEntityCaptureCostCapInput } = await import('../core/cycle/entity-capture-budget.ts');
    const cap = parseEntityCaptureCostCapInput(req.body?.costCap);
    if (cap === undefined) {
      res.status(400).json({ error: 'entity_capture_cost_cap_invalid' });
      return;
    }
    try {
      await engine.setConfig('dream.entity_capture.cost_cap_cny', cap == null ? 'unlimited' : String(cap));
      sendAdminContract(res, EntityCaptureBudgetResponseSchema, await entityCaptureBudgetView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_entity_capture_budget_failed' });
    }
  });

  app.get('/admin/api/dream/overview', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // The generative switch is file-plane state and can change while the
      // HTTP service stays alive. Do not keep the startup snapshot here or
      // Dream will remain grey until the whole Sidecar restarts.
      sendAdminContract(
        res,
        DreamOverviewResponseSchema,
        await getAdminDreamOverview(engine, loadConfig() ?? config, VERSION),
      );
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_overview_failed' });
    }
  });

  const dreamSettingsView = async (overrides?: { outputDir?: string; dualWrite?: boolean; includeUncommitted?: boolean; autoGitCommit?: boolean }) => {
    const [storedOutputDir, storedDualWrite, storedBrainDir, storedIncludeUncommitted, storedAutoGitCommit] = await Promise.all([
      engine.getConfig('dream.synthesize.output_dir'),
      engine.getConfig('dream.synthesize.dual_write'),
      engine.getConfig('sync.repo_path'),
      engine.getConfig('sync.include_working_tree'),
      engine.getConfig('sync.auto_git_commit'),
    ]);
    const outputDir = overrides?.outputDir ?? (storedOutputDir?.trim() || 'output');
    const dualWrite = overrides?.dualWrite ?? (storedDualWrite !== 'false');
    const includeUncommitted = overrides?.includeUncommitted ?? (storedIncludeUncommitted === 'true');
    const autoGitCommit = overrides?.autoGitCommit ?? storedAutoGitCommit !== 'false';
    const defaultBrainDir = storedBrainDir?.trim() || brainDirFromConfig(config);
    const resolvedOutputDir = defaultBrainDir
      ? resolveDreamOutputRoot(defaultBrainDir, outputDir)
      : /^[A-Za-z]:[\\/]/.test(outputDir) || /^\\\\/.test(outputDir) || outputDir.startsWith('/')
        ? resolveDreamOutputRoot('.', outputDir)
        : null;
    return {
      outputDir,
      dualWrite,
      includeUncommitted,
      autoGitCommit,
      defaultBrainDir: defaultBrainDir || null,
      resolvedOutputDir,
      directoryExists: resolvedOutputDir ? existsSync(resolvedOutputDir) : false,
    };
  };

  app.get('/admin/api/dream/settings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, DreamSettingsResponseSchema, await dreamSettingsView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'dream_settings_failed' });
    }
  });

  const generativeUsageView = async () => {
    const {
      isGenerativeModelEnabled,
      generativeCapabilitySummary,
      getPhaseCapabilities,
    } = await import('../core/model-usage.ts');
    const cfg = loadConfig();
    const summary = generativeCapabilitySummary(cfg);
    return {
      ...summary,
      phase_capabilities: getPhaseCapabilities(),
      chat_model: cfg?.chat_model ?? null,
    };
  };

  app.get('/admin/api/model-usage/generative', requireAdmin, async (_req: Request, res: Response) => {
    try {
      sendAdminContract(res, GenerativeUsageResponseSchema, await generativeUsageView());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'generative_usage_failed' });
    }
  });

  app.post('/admin/api/model-usage/generative', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'generative_enabled_must_be_boolean' });
      return;
    }
    try {
      const {
        setGenerativeModelEnabled,
        isGenerativeModelEnabled,
        phaseRequiresGenerativeModel,
      } = await import('../core/model-usage.ts');
      const wasEnabled = isGenerativeModelEnabled(loadConfig());
      setGenerativeModelEnabled(enabled);
      let stopped: Array<{ id: string; kind: string; status: string }> = [];
      if (wasEnabled && !enabled) {
        const active = (await readRuns()).filter((run) => {
          if (run.status !== 'running' && run.status !== 'queued') return false;
          if (!run.kind.startsWith('dream_')) return false;
          if (run.kind.includes('quick')) return false;
          const phase = run.kind.replace(/^dream_/, '');
          if (phase === 'full' || phase === 'meeting' || phase === 'cycle') return true;
          return phaseRequiresGenerativeModel(phase);
        });
        for (const run of active) {
          const next = await productTasks.cancel(run.id) ?? await cancelRun(run.id);
          if (next) stopped.push({ id: next.id, kind: next.kind, status: next.status });
        }
        console.error(
          `[model-usage] generative disabled; stopped ${stopped.length} AI organize run(s).`,
        );
      }
      sendAdminContract(res, GenerativeUsageResponseSchema, { ...(await generativeUsageView()), stopped_runs: stopped });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_generative_usage_failed' });
    }
  });

  app.post('/admin/api/dream/settings', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const rawOutputDir = typeof req.body?.outputDir === 'string' ? req.body.outputDir.trim() : '';
    const dualWrite = req.body?.dualWrite;
    const includeUncommitted = req.body?.includeUncommitted;
    const autoGitCommit = req.body?.autoGitCommit;
    if (autoGitCommit !== undefined && typeof autoGitCommit !== 'boolean') { res.status(400).json({error:'auto_git_commit_must_be_boolean'}); return; }
    if (!rawOutputDir || rawOutputDir.length > 1024 || rawOutputDir.includes('\0')) {
      res.status(400).json({ error: 'invalid_dream_output_dir' });
      return;
    }
    if (typeof dualWrite !== 'boolean') {
      res.status(400).json({ error: 'dream_dual_write_must_be_boolean' });
      return;
    }
    if (typeof includeUncommitted !== 'boolean') {
      res.status(400).json({ error: 'sync_include_uncommitted_must_be_boolean' });
      return;
    }
    const outputDir = rawOutputDir === '/output' || rawOutputDir === '\\output' ? 'output' : rawOutputDir;
    try {
      const view = await dreamSettingsView({ outputDir, dualWrite, includeUncommitted, autoGitCommit });
      if (dualWrite && !view.resolvedOutputDir) {
        res.status(400).json({ error: 'dream_default_directory_unavailable' });
        return;
      }
      if (dualWrite && view.resolvedOutputDir) {
        await ensureDreamOutputDirectory(view.resolvedOutputDir);
      }
      await Promise.all([
        engine.setConfig('dream.synthesize.output_dir', outputDir),
        engine.setConfig('dream.synthesize.dual_write', dualWrite ? 'true' : 'false'),
        engine.setConfig('sync.include_working_tree', includeUncommitted ? 'true' : 'false'),
        ...(typeof autoGitCommit==='boolean' ? [engine.setConfig('sync.auto_git_commit',autoGitCommit?'true':'false')] : []),
      ]);
      sendAdminContract(res, DreamSettingsResponseSchema, await dreamSettingsView({ outputDir, dualWrite, includeUncommitted, autoGitCommit }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'save_dream_settings_failed' });
    }
  });

  app.post('/admin/api/dream/locks/:id/break', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const holderPid = Number(req.body?.holderPid);
    if (!id || !Number.isFinite(holderPid) || holderPid <= 0) {
      res.status(400).json({ error: 'lock_id_and_holder_pid_required' });
      return;
    }
    try {
      res.json(await deleteLockRow(engine, id, holderPid));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'break_lock_failed' });
    }
  });

  app.post('/admin/api/jobs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'job_id_required' });
      return;
    }
    try {
      const queue = new MinionQueue(engine);
      await queue.ensureSchema();
      const job = await queue.cancelJob(id);
      if (!job) {
        res.status(409).json({ error: 'job_not_cancellable' });
        return;
      }
      res.json({ cancelled: true, job });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'job_cancel_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/start', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(await ensureAdminWorkerStarted());
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_start_failed' });
    }
  });

  app.post('/admin/api/jobs/supervisor/stop', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { spawn } = await import('child_process');
      const command = [...resolveCliEntry(), 'jobs', 'supervisor', 'stop', '--json'];
      const child = spawn(command[0], command.slice(1), {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
      let stdout = '';
      child.stdout?.on('data', chunk => {
        stdout = (stdout + String(chunk)).slice(-64_000);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      const payload = line ? JSON.parse(line) as Record<string, unknown> : {};
      if (code !== 0 && payload.stopped !== false) {
        throw new Error(`supervisor_stop_failed_exit_${code ?? 'unknown'}`);
      }
      res.json({ ...payload, mode: 'supervisor' });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'supervisor_stop_failed' });
    }
  });

  app.get('/admin/api/docs', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const readme = await loadAdminReadmeMarkdown();
      res.json({
        readme_source: readme.source,
        readme_path: readme.path ?? null,
        articles: [
          {
            id: 'readme',
            title: 'README.md',
            category: '使用文档',
            markdown: readme.markdown,
          },
          {
            id: 'faq',
            title: '常见问题',
            category: '常见问题',
            markdown: ADMIN_DOCS_EMPTY_MARKDOWN,
          },
        ],
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'docs_failed' });
    }
  });

  app.get('/admin/api/brain/pages', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainPagesResponseSchema, await listAdminBrainPages(engine, {
        source: req.query.source as string | undefined,
        type: req.query.type as string | undefined,
        view: req.query.view as string | undefined,
        q: req.query.q as string | undefined,
        embedded: req.query.embedded as string | undefined,
        page: req.query.page as string | undefined,
        limit: req.query.limit as string | undefined,
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'pages_failed' });
    }
  });

  app.post('/admin/api/memory/writeback/agent', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const {agent,mcpConfirmed,serveUrl,remove}=req.body??{};
      if(remove===true&&['codex','claude'].includes(agent)){
        const {removeWritebackAgent}=await import('../core/bootstrap/writeback-agents.ts');
        const {getWritebackStatus}=await import('../core/facts/writeback-set.ts');
        removeWritebackAgent({agent});
        sendAdminContract(res,MemoryWritebackStatusSchema,await getWritebackStatus(engine));
        return;
      }
      if(!['codex','claude'].includes(agent)||mcpConfirmed!==true)throw new Error('请先成功接入 Codex 或 Claude Code MCP');
      const url=new URL(serveUrl);
      if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/mcp')throw new Error('深度接入只允许本机 PMBrain');
      const {resolveMainSourceId}=await import('../core/source-resolver.ts');
      const {getWritebackStatus}=await import('../core/facts/writeback-set.ts');
      const {installWritebackAgent,buildWritebackHookCommand}=await import('../core/bootstrap/writeback-agents.ts');
      const state=await getWritebackStatus(engine);
      const sourceId=await resolveMainSourceId(engine);
      installWritebackAgent({agent,mcpConfirmed,sourceId,serveUrl,mode:state.mode,ttl:state.ttl,visibility:state.visibility,command:buildWritebackHookCommand(sourceId,agent==='codex'?'session-end':'stop')});
      sendAdminContract(res,MemoryWritebackStatusSchema,await getWritebackStatus(engine));
    }catch(e){res.status(400).json({error:e instanceof Error?e.message:'agent_writeback_failed'});}
  });

  app.get('/admin/api/memory/writeback', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { getWritebackStatus } = await import('../core/facts/writeback-set.ts');
      sendAdminContract(res, MemoryWritebackStatusSchema, await getWritebackStatus(engine));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'memory_writeback_failed' });
    }
  });

  app.post('/admin/api/memory/writeback', requireAdmin, express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    try {
      const parsed = MemoryWritebackUpdateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_params' });
        return;
      }
      const { setWritebackMode, stampWritebackNoticeShown, getWritebackStatus } = await import('../core/facts/writeback-set.ts');
      if (parsed.data.mode) {
        await setWritebackMode(engine, parsed.data.mode, { ttl: parsed.data.ttl });
      }
      if (parsed.data.notice_shown || parsed.data.mode) {
        await stampWritebackNoticeShown(engine);
      }
      sendAdminContract(res, MemoryWritebackStatusSchema, await getWritebackStatus(engine));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'memory_writeback_update_failed' });
    }
  });

  app.get('/admin/api/brain/facts', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, BrainFactsResponseSchema, await listAdminBrainFacts(engine, {
        source: req.query.source as string | undefined,
        type: req.query.type as string | undefined,
        q: req.query.q as string | undefined,
        embedded: req.query.embedded as string | undefined,
        page: req.query.page as string | undefined,
        limit: req.query.limit as string | undefined,
        includeExpired: req.query.includeExpired as string | undefined,
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'facts_failed' });
    }
  });

  app.get('/admin/api/brain/facts/:id', requireAdmin, async (req: Request, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid_fact_id' });
      return;
    }
    try {
      const fact = await getAdminBrainFact(engine, id);
      if (!fact) {
        res.status(404).json({ error: 'fact_not_found' });
        return;
      }
      sendAdminContract(res, BrainFactDetailResponseSchema, fact);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'fact_detail_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/edge/:id', requireAdmin, async (req: Request, res: Response) => {
    try { res.json(await getAdminKnowledgeGraphEdge(engine, Number(req.params.id))); }
    catch (error) { res.status(400).json({error: error instanceof Error ? error.message : String(error)}); }
  });

  app.get('/admin/api/knowledge-graph/meta', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphMetaResponseSchema, await getAdminKnowledgeGraphMeta(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_meta_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/global', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphGlobalResponseSchema, await getAdminKnowledgeGraphGlobal(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
        relationType: firstQueryValue(req.query.relationType),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_global_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/isolated', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphGlobalResponseSchema, await getAdminKnowledgeGraphIsolated(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_isolated_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/missing', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphMissingLinksResponseSchema, await getAdminKnowledgeGraphMissingLinks(engine, {
        sourceId: firstQueryValue(req.query.sourceId),
      }));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'knowledge_graph_missing_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/search', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphSearchResponseSchema, await searchAdminKnowledgeGraphPages(engine, {
        query: firstQueryValue(req.query.q),
        sourceId: firstQueryValue(req.query.sourceId),
        limit: Number(firstQueryValue(req.query.limit)),
      }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'knowledge_graph_search_failed' });
    }
  });

  app.get('/admin/api/knowledge-graph/neighborhood', requireAdmin, async (req: Request, res: Response) => {
    try {
      sendAdminContract(res, KnowledgeGraphNeighborhoodResponseSchema, await getAdminKnowledgeGraphNeighborhood(engine, {
        sourceId: firstQueryValue(req.query.sourceId) ?? '',
        slug: firstQueryValue(req.query.slug) ?? '',
        relationType: firstQueryValue(req.query.relationType),
        limit: Number(firstQueryValue(req.query.limit)),
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'knowledge_graph_neighborhood_failed';
      res.status(message === 'knowledge_graph_page_not_found' ? 404 : 400).json({ error: message });
    }
  });

  app.get('/admin/api/brain/pages/:sourceId/:slug', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const page = await getAdminBrainPageDetail(engine, sourceId, slug, req.query.includeDeleted === '1');
      if (!page) {
        res.status(404).json({ error: 'page_not_found' });
        return;
      }
      sendAdminContract(res, BrainPageDetailResponseSchema, page);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'page_detail_failed' });
    }
  });

  const runAdminPageOperation = async (operation: 'delete_page' | 'restore_page', sourceId: string, slug: string) => {
    const result = await dispatchToolCall(engine, operation, { slug }, { remote: false, sourceId });
    const text = (result.content[0] as { text?: string } | undefined)?.text ?? '{}';
    return { payload: JSON.parse(text) as Record<string, unknown>, isError: result.isError === true };
  };

  app.post('/admin/api/brain/pages/:sourceId/:slug/delete', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const result = await runAdminPageOperation('delete_page', sourceId, slug);
      res.status(result.isError ? 400 : 200).json(result.payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'page_delete_failed' });
    }
  });

  app.post('/admin/api/brain/pages/:sourceId/:slug/restore', requireAdmin, async (req: Request, res: Response) => {
    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    try {
      const result = await runAdminPageOperation('restore_page', sourceId, slug);
      res.status(result.isError ? 400 : 200).json(result.payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'page_restore_failed' });
    }
  });

  app.get('/admin/api/brain/pages/:sourceId/:slug/chunks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
      const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
      if (!sourceId || !slug) {
        res.status(400).json({ error: 'missing_page_identity' });
        return;
      }
      sendAdminContract(res, BrainPageChunksResponseSchema, await getAdminBrainPageChunks(engine, sourceId, slug, req.query.includeDeleted === '1'));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'chunks_failed' });
    }
  });

  app.get('/admin/api/llm/status', requireAdmin, (_req: Request, res: Response) => {
    sendAdminContract(res, LlmStatusResponseSchema, getAdminLlmStatus(config));
  });

  app.post('/admin/api/intent/preview', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const preview = await previewIntent(text, config);
      res.json(preview);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_preview_failed' });
    }
  });

  app.post('/admin/api/intent/execute', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const previewId = typeof req.body?.previewId === 'string' ? req.body.previewId : '';
      const confirmed = req.body?.confirmed === true;
      const run = await executePreview(engine, previewId, confirmed, process.cwd(), runHooks);
      sendAdminContract(res, RunAcceptedResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'intent_execute_failed' });
    }
  });

  app.post('/admin/api/think-runs', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    try {
      const run = await startThinkRun(question, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'think_run_failed' });
    }
  });

  // Knowledge workbench search: keyword (full-text) or semantic (hybrid, no chat expand).
  // Does not call think / ordinary chat models.
  app.post('/admin/api/knowledge-search', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const payload = await runAdminKnowledgeSearch(engine, {
        query: typeof req.body?.query === 'string' ? req.body.query : '',
        mode: req.body?.mode,
        limit: req.body?.limit,
      });
      res.json(payload);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'knowledge_search_failed' });
    }
  });

  app.post('/admin/api/capture-runs', requireAdmin, express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined;
      const run = await startCaptureRun(content, sourceId, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'capture_run_failed' });
    }
  });

  app.get('/admin/api/runs', requireAdmin, async (req: Request, res: Response) => {
    const runs = await readRuns();
    res.json({ rows: req.query.summary === '1' ? runs.map(taskRunSummary) : runs });
  });

  app.get('/admin/api/runs/:id', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? await readRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.get('/admin/api/runs/:id/relations', requireAdmin, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!/^task-\d+$/.test(id) || !await productTasks.getRun(id)) { res.status(404).json({error:'run_not_found'}); return; }
    try { res.json(await readTaskRelations(engine, Number(id.slice(5)), Math.max(0, Number(req.query.after)||0))); }
    catch (error) { res.status(500).json({error:error instanceof Error ? error.message : String(error)}); }
  });

  app.get('/admin/api/runs/:id/files', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = id ? await productTasks.files(id, Number(req.query.after ?? 0)) : null;
    if (!result) { res.status(404).json({ error: 'run_not_found' }); return; }
    res.json(result);
  });

  app.post('/admin/api/runs/:id/cancel', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? await productTasks.requestCancel(id) ?? await cancelRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.post('/admin/api/console/resource-stop',requireAdmin,express.json({limit:'4kb'}),async(req:Request,res:Response)=>{
    if(req.body?.action==='adjust'){
      if(typeof req.body.constrained!=='boolean'){res.status(400).json({error:'resource_pressure_must_be_boolean'});return;}
      await productTasks.adjustResourcePressure(req.body.constrained);
      res.status(202).json({status:req.body.constrained?'throttled':'normal'});return;
    }
    const reason=typeof req.body?.message==='string'?req.body.message.slice(0,1024):'资源保护：本地服务内存不足，已停止后台任务，请释放内存后重启服务并手动继续。';
    productTasks.stopForResourcePressure(reason);
    res.status(202).json({status:'stopping'});
  });

  app.post('/admin/api/runs/:id/retry', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const run = id ? await productTasks.retry(id) : null;
      if (!run) { res.status(404).json({ error: 'run_not_found' }); return; }
      sendAdminContract(res, RunAcceptedResponseSchema, { runId: run.id, status: run.status }, 202);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/admin/api/runs/action', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const action = req.body?.action;
      if (!['doctor_check', 'show_sources', 'show_stats', 'embed_stale', 'sync_all'].includes(action)) {
        res.status(400).json({ error: 'unsupported_action' });
        return;
      }
      const run = action === 'embed_stale' ? await productTasks.submitEmbed({
        catchUp: req.body?.catchUp === true,
        forceReembed: action === 'embed_stale' && req.body?.forceReembed === true,
      }) : action === 'sync_all'
        ? await productTasks.submitSync()
        : await startActionRun(action, process.cwd(), runHooks, {});
      if (action === 'embed_stale' && req.body?.forceReembed === true) {
        const { markEmbeddingRebuildRunning } = await import('../core/embedding-rebuild-state.ts');
        markEmbeddingRebuildRunning();
      }
      sendAdminContract(res, RunAcceptedResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'action_run_failed' });
    }
  });

  app.post('/admin/api/import-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const input = ImportRunRequestSchema.parse(req.body);
      const run = await productTasks.submitImport({
        path: input.path,
        sourceId: input.sourceId,
        includeOffice: true,
        includeImages: true,
        noEmbed: false,
        structuredDocuments: true,
        documentOcr: true,
        workers: input.workers,
      });
      sendAdminContract(res, ImportRunResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'import_run_failed' });
    }
  });

  app.post(
    '/admin/api/import-upload-runs',
    requireAdmin,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const fileName = normalizeAdminUploadFilename(req.get('x-pmbrain-filename'));
        if (classifyAdminUploadFilename(fileName) === 'session') {
          next();
          return;
        }
        express.raw({ type: 'application/octet-stream', limit: ADMIN_UPLOAD_MAX_BYTES })(req, res, next);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'import_upload_run_failed';
        res.status(message.startsWith('Unsupported file type:') ? 415 : 400).json({ error: message });
      }
    },
    async (req: Request, res: Response) => {
      let tempDir: string | null = null;
      try {
        const fileName = normalizeAdminUploadFilename(req.get('x-pmbrain-filename'));
        const fileKind = classifyAdminUploadFilename(fileName);
        if (fileKind !== 'session' && (!Buffer.isBuffer(req.body) || req.body.length === 0)) {
          res.status(400).json({ error: 'Upload body is required' });
          return;
        }
        const workersRaw = firstQueryValue(req.query.workers);
        const workers = workersRaw ? Number(workersRaw) : 1;
        if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
          throw new Error('Upload workers must be an integer from 1 to 8');
        }

        tempDir = await mkdtemp(joinPath(tmpdir(), 'pmbrain-admin-upload-'));
        const filePath = joinPath(tempDir, fileName);
        if (fileKind === 'session') {
          await pipeline(req, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
          if ((await stat(filePath)).size === 0) throw new Error('Upload body is required');
        } else {
          await writeFile(filePath, req.body, { flag: 'wx', mode: 0o600 });
        }

        const run = await productTasks.submitImport({
          path: filePath,
          sourceId: firstQueryValue(req.query.sourceId),
          includeOffice: true,
          includeImages: true,
          noEmbed: false,
          structuredDocuments: true,
          documentOcr: true,
          workers,
          stagingDir: tempDir,
        });
        sendAdminContract(res, ImportUploadRunResponseSchema, { runId: run.id, status: run.status, fileName }, 202);
      } catch (e) {
        if (tempDir) await removeAdminUploadTempDir(tempDir);
        const message = e instanceof Error ? e.message : 'import_upload_run_failed';
        res.status(message.startsWith('Unsupported file type:') ? 415 : 400).json({ error: message });
      }
    },
  );

  app.post('/admin/api/export-runs', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    try {
      const { run, outputDir } = await startMarkdownExportRun(rootPath, process.cwd(), runHooks);
      res.status(202).json({ runId: run.id, status: run.status, outputDir });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'export_run_failed' });
    }
  });

  app.post('/admin/api/dream-runs', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const rawMaxPages = req.body?.maxPages;
      const maxPages = rawMaxPages === undefined || rawMaxPages === null || rawMaxPages === ''
        ? undefined
        : Number(rawMaxPages);
      const configured = loadConfig() ?? config;
      const request = normalizeAdminDreamRequest({
        phase: typeof req.body?.phase === 'string' ? req.body.phase : undefined,
        preset: ['full', 'meeting', 'quick'].includes(req.body?.preset) ? req.body.preset : undefined,
        sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined,
        allSources: req.body?.allSources === true,
        maxPages,
        drainProposals: req.body?.drainProposals === true,
        windowSeconds: typeof req.body?.windowSeconds === 'number' ? req.body.windowSeconds : undefined,
        dryRun: req.body?.dryRun === true,
        input: typeof req.body?.input === 'string' ? req.body.input : undefined,
        date: typeof req.body?.date === 'string' ? req.body.date : undefined,
        from: typeof req.body?.from === 'string' ? req.body.from : undefined,
        to: typeof req.body?.to === 'string' ? req.body.to : undefined,
        timeoutMs: typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
      }, {
        engine: configured.engine,
        chatModel: configured.chat_model,
      });
      const run = await productTasks.submitDream(request);
      sendAdminContract(res, DreamRunResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      const { errorPayloadFromGenerativeDisabled } = await import('../core/model-usage.ts');
      const generative = errorPayloadFromGenerativeDisabled(e);
      if (generative) {
        res.status(403).json(generative);
        return;
      }
      res.status(400).json({ error: e instanceof Error ? e.message : 'dream_run_failed' });
    }
  });

  app.post('/admin/api/sources', requireAdmin, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
    try {
      const run = await startSourceAddRun({
        id: typeof req.body?.id === 'string' ? req.body.id : '',
        path: typeof req.body?.path === 'string' ? req.body.path : '',
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
        federated: req.body?.federated !== false,
      }, process.cwd(), runHooks);
      sendAdminContract(res, SourceAddResponseSchema, { runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_add_failed' });
    }
  });

  app.post('/admin/api/sources/:id/git/:action', requireAdmin, express.json({ limit: '8kb' }), async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawAction = Array.isArray(req.params.action) ? req.params.action[0] : req.params.action;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (rawAction !== 'init' && rawAction !== 'commit') {
      res.status(400).json({ error: 'source_git_action_invalid' });
      return;
    }
    try {
      const run = await startSourceGitRun(
        id,
        rawAction,
        typeof req.body?.message === 'string' ? req.body.message : undefined,
        process.cwd(),
        runHooks,
      );
      res.status(202).json({ runId: run.id, status: run.status });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_git_failed' });
    }
  });

  app.post('/admin/api/sources/:id/archive', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    if (id === 'default') {
      res.status(400).json({ error: 'default_source_cannot_be_archived' });
      return;
    }
    try {
      if (id === await resolveMainSourceId(engine)) {
        res.status(400).json({ error: 'main_source_cannot_be_archived', message: '请先在设置中切换主知识库源。' });
        return;
      }
      const impact = await assessDestructiveImpact(engine, id);
      if (!impact) {
        res.status(404).json({ error: 'source_not_found' });
        return;
      }
      const archived = await softDeleteSource(engine, id);
      if (!archived) {
        res.status(409).json({ error: 'source_already_archived_or_missing' });
        return;
      }
      res.json({ archived, impact });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_archive_failed' });
    }
  });

  app.post('/admin/api/sources/:id/restore', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: 'source_id_required' });
      return;
    }
    try {
      const restored = await restoreSource(engine, id);
      if (!restored) {
        res.status(404).json({ error: 'source_not_found_or_not_archived' });
        return;
      }
      res.json({ id, restored: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'source_restore_failed' });
    }
  });

  app.get('/admin/api/import-runs/:id', requireAdmin, async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const run = id ? await readRun(id) : null;
    if (!run) {
      res.status(404).json({ error: 'run_not_found' });
      return;
    }
    res.json(run);
  });

  app.get('/admin/api/doctor', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const checks = await buildDoctorChecks(engine, ['--fast', '--scope=brain']);
      res.json({ mode: 'fast', scope: 'brain', checks });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'doctor_failed' });
    }
  });
  return { checkScheduledDream };
}
