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

import type { BrainEngine } from '../core/engine.ts';
import type { ContextPackHandler } from '../core/context/resolve-ipc.ts';
import { CONTEXT_PACK_SERVER_BUDGET_MS } from '../core/context/resolve-ipc.ts';
import { assembleContextPack } from '../core/context/turn-context.ts';
import { extractCandidatesFromWindow } from '../core/context/entity-salience.ts';
import {
  getSessionContextState,
  upsertSessionContextState,
} from '../core/context/session-state.ts';

/** Tighter entity-card fan-out on the PUSH path (eng 4A): the server budget
 * can't absorb the pull path's 8-card ceiling on a cold cache. */
export const PUSH_PACK_MAX_ENTITIES = 4;

export function makeContextPackIpcHandler(
  engine: BrainEngine,
  defaultSource: string,
): ContextPackHandler {
  return async (req) => {
    const sessionId =
      typeof req.sessionId === 'string' && req.sessionId.trim() ? req.sessionId : null;
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
      return { text: '', pointers: [], factsCount: 0, mode: 'pack' as const };
    }

    const result = await assembleContextPack(engine, {
      sourceId: defaultSource,
      entities,
      sessionId: sessionId ?? undefined,
      since: state?.last_wake_at ?? undefined,
      maxEntities: PUSH_PACK_MAX_ENTITIES,
      deadlineMs: CONTEXT_PACK_SERVER_BUDGET_MS,
      // includePrivate NEVER set on the push path (D2=A).
    });
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
