/**
 * v0.45.7 ambient recall — the serve-side context_pack IPC handler, extracted
 * from startMcpServer's closure so it is directly testable against a real
 * engine (ship coverage audit: the closure form was only ever exercised via
 * canned mock handlers).
 *
 * The RUNTIME owns the intelligence — entity resolution (request entities +
 * window extraction + the session row's banked set), the since-cursor, and
 * cursor advancement — the hook just fires the event and injects stdout.
 * World-only ALWAYS (the push path never widens; include_private is a
 * pull-verb affordance). Fail-open: session-state trouble degrades to a
 * stateless pack, never an error.
 */

import { readPressureGate } from '../core/context/pressure.ts';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { ContextPackHandler } from '../core/context/resolve-ipc.ts';
import { CONTEXT_PACK_SERVER_BUDGET_MS } from '../core/context/resolve-ipc.ts';
import { assembleContextPack } from '../core/context/turn-context.ts';
import { extractCandidatesFromWindow } from '../core/context/entity-salience.ts';
import {
  getCheckpointManifest,
  getSessionContextState,
  upsertSessionContextState,
} from '../core/context/session-state.ts';
import { scheduleCheckpointHarvest, type HarvestAck } from '../core/context/checkpoint-harvest.ts';
import { parseWbFileName } from '../core/context/corpus-segments.ts';
import { loadCoreBlock } from '../core/core-memory.ts';
import { coreTrustIdentity } from '../core/context/openclaw-core.ts';
import type { TurnContextResult } from '../core/context/turn-context.ts';

/** Tighter entity-card fan-out on the PUSH path (eng 4A): the server budget
 * can't absorb the pull path's 8-card ceiling on a cold cache. */
export const PUSH_PACK_MAX_ENTITIES = 4;

/** Segment basenames only: no separators, no traversal, `.txt` suffix. */
const SAFE_CORPUS_BASENAME = /^[A-Za-z0-9._-]{1,240}\.txt$/;

/** Corpus dir resolved the SERVE way (sweep.ts precedent) — the hook resolves
 * its own from file config; under a misconfigured split a flushed basename
 * may not exist here, answered with a typed not_found skip (the sweep
 * backstop covers wherever the hook actually wrote). */
async function serveCorpusDir(engine: BrainEngine): Promise<string> {
  const configured = await engine.getConfig('dream.synthesize.session_corpus_dir');
  // isAbsolute parity with the hook/engine resolvers (pre-landing review):
  // a relative config value must never resolve against the serve cwd.
  if (configured && isAbsolute(configured)) return configured;
  const { configDir } = await import('../core/config.ts');
  return join(configDir(), 'transcripts', 'corpus');
}

/** The session's core block for the push path; null on any failure (fail-open, never blocks a pack). */
async function coreForSession(engine: BrainEngine, sourceId: string): Promise<TurnContextResult['core'] | null> {
  try {
    const block = await loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: true });
    return { text: block.text, revision: block.revision, chars_used: block.chars_used, chars_limit: block.chars_limit, truncated: block.truncated };
  } catch {
    return null;
  }
}

export function makeContextPackIpcHandler(
  engine: BrainEngine,
  defaultSource: string,
): ContextPackHandler {
  return async (req) => {
    const sessionId =
      typeof req.sessionId === 'string' && req.sessionId.trim() ? req.sessionId : null;

    // Cathedral 5 — read-only manifest poll (OpenClaw assemble): no assembly,
    // no cursor advance, no banking. One SELECT. A FAILED read omits the
    // checkpointLinks field entirely — the engine's capability probe treats
    // that as "unavailable" and keeps its retry budget, whereas an empty
    // array is a CONFIRMED empty manifest and settles the poll.
    const sessionSource = typeof req.sourceId === 'string' && req.sourceId.trim() ? req.sourceId : defaultSource;
    if (req.coreOnly === true) {
      // #5575 ENG-11: the trust identity is read before the core content; a
      // client memo whose identity still matches is revalidated without assembly.
      const identity = await coreTrustIdentity(engine);
      // The OpenClaw lane reads the pressure gate on the same fetch; it checks remember's availability itself.
      const pressure = await readPressureGate(engine, true).catch(() => null);
      const base = { text: '', pointers: [], factsCount: 0, mode: 'pack' as const, ...(pressure ? { pressure } : {}) };
      if (identity !== null && identity === req.coreIdentity) return { ...base, coreTrust: { identity, unchanged: true } };
      const core = await coreForSession(engine, sessionSource);
      return { ...base, ...(core ? { core } : {}), ...(core && identity !== null ? { coreTrust: { identity, unchanged: false } } : {}) };
    }
    if (req.manifestOnly === true) {
      const links = sessionId
        ? await getCheckpointManifest(engine, defaultSource, null, sessionId)
        : [];
      return {
        text: '', pointers: [], factsCount: 0, mode: 'pack' as const,
        ...(links !== null ? { checkpointLinks: links } : {}),
      };
    }
    // Merge: fresh request entities first, then window-extracted candidates,
    // then the session row's banked standing set.
    const fromReq = Array.isArray(req.entities)
      ? req.entities.filter((e): e is string => typeof e === 'string' && !!e.trim())
      : [];
    let fromWindow: string[] = [];
    try {
      if (Array.isArray(req.window) && req.window.length) {
        fromWindow = extractCandidatesFromWindow(req.window).map((c) => c.query);
      }
    } catch { /* extraction is best-effort */ }
    const state = sessionId
      ? await getSessionContextState(engine, defaultSource, null, sessionId)
      : null;
    const banked = state?.standing_entities ?? [];
    const entities = Array.from(new Set([...fromReq, ...fromWindow, ...banked]));

    if (req.bankOnly === true) {
      // PreCompact banking: persist the standing set for the post-compaction
      // SessionStart; no assembly, empty block.
      if (sessionId && entities.length) {
        await upsertSessionContextState(engine, defaultSource, null, sessionId, {
          standingEntities: entities.slice(0, PUSH_PACK_MAX_ENTITIES * 2),
        });
      }
      // Cathedral 5 — flushCorpusFile companion: schedule a prompt harvest of
      // the segment the hook just banked. Fire-and-forget (the ack never
      // waits on the LLM); every failure is a typed skip — the sweep backstop
      // extracts the segment later regardless.
      let checkpointFlush: HarvestAck | undefined;
      if (typeof req.flushCorpusFile === 'string' && req.flushCorpusFile) {
        const base = req.flushCorpusFile;
        if (!SAFE_CORPUS_BASENAME.test(base) || base.includes('..')) {
          checkpointFlush = { status: 'skipped', reason: 'bad_basename' };
        } else if (!sessionId) {
          checkpointFlush = { status: 'skipped', reason: 'no_session' };
        } else {
          const dir = await serveCorpusDir(engine);
          if (!existsSync(join(dir, base))) {
            checkpointFlush = { status: 'skipped', reason: 'not_found' };
          } else {
            // Ambient-writeback turn files ride the SAME bank lane with a
            // basename-derived lane tag (WP4): `.wb-<hash>` files get the
            // serve-side auto_writeback gate, the salient notability filter,
            // and no manifest publish. Lane derivation uses the ONE parser
            // (corpus-segments.ts) — a hand-rolled regex here could drift
            // from the writer's naming and silently route wb files down the
            // compact lane, past the writeback gate.
            const lane = parseWbFileName(base) !== null ? ('writeback' as const) : ('compact' as const);
            checkpointFlush = scheduleCheckpointHarvest({
              engine, sourceId: defaultSource, sessionId, corpusDir: dir, file: base, lane,
            });
          }
        }
      }
      return {
        text: '', pointers: [], factsCount: 0, mode: 'pack' as const,
        ...(checkpointFlush ? { checkpointFlush } : {}),
      };
    }

    const result = await assembleContextPack(engine, {
      sourceId: defaultSource,
      entities,
      sessionId: sessionId ?? undefined,
      since: state?.last_wake_at ?? undefined,
      maxEntities: PUSH_PACK_MAX_ENTITIES,
      deadlineMs: CONTEXT_PACK_SERVER_BUDGET_MS,
      // includePrivate NEVER set on the push path (D2=A).
      // Cathedral 5: banked checkpoint links ride the assembled pack so the
      // post-compaction SessionStart renders them (fail-open []; links that
      // missed this pack surface on the next boundary — at-least-once).
      ...(sessionId
        ? { checkpointLinks: (await getCheckpointManifest(engine, defaultSource, null, sessionId)) ?? [] }
        : {}),
    });
    const core = typeof req.trigger === 'string' && req.trigger.startsWith('session-start') ? await coreForSession(engine, sessionSource) : null;
    if (core) result.core = core;
    if (sessionId) {
      // Bank the standing set; advance the wake cursor only on a COMPLETE
      // pack — a deadline-partial pack may have dropped the delta section,
      // and advancing past it would lose those changes. (A client-side drop
      // after a complete server response can still skip one delta window —
      // known at-most-once edge of the push path; the pull `delta` verb is
      // the lossless channel.) The cursor upsert is monotonic (GREATEST), so
      // an interleaved delta advance is never rewound.
      await upsertSessionContextState(engine, defaultSource, null, sessionId, {
        standingEntities: entities.slice(0, PUSH_PACK_MAX_ENTITIES * 2),
        ...(result.degradedReason ? {} : { lastWakeAt: new Date().toISOString() }),
      });
    }
    return result;
  };
}
