/**
 * The gateway's mutable state as a value, so a process can hold one per engine.
 *
 * `processGatewayState` is the state `configureGateway` writes and every call
 * outside an engine scope reads: the CLI and `gbrain serve` configure the
 * gateway once per process and never see another state. A host that opens
 * several engines in one process records a state per engine with
 * `configureGatewayForEngine(engine, config)` (gateway.ts); a call that runs
 * inside `withEngineScope(engine, ...)` (engine-scope.ts, entered by every
 * operation handler) then reads that engine's config, model cache, transports
 * and discovery, and falls back to the process-wide state for an engine
 * nothing was recorded against.
 *
 * Only the state that names a brain lives here: which provider keys and base
 * URLs a call uses, which models answer, the clients built from them, the one
 * OpenAI discovery run per reconfigure, and the scope of the query-embedding
 * cache. Adaptive counters that are not identity-bearing (the shrink-on-miss
 * state, the once-per-process warnings) stay module-level in gateway.ts.
 */
import type { embedMany, generateObject, generateText } from 'ai';
import type { BrainEngine } from '../engine.ts';
import { engineInScope, engineOwned } from '../engine-scope.ts';
import type { AIGatewayConfig } from './types.ts';
import type { ChatOpts, ChatResult } from './gateway.ts';

export type EmbedManyFn = typeof embedMany;
export type GenerateTextFn = typeof generateText;
export type GenerateObjectFn = typeof generateObject;
export type ChatTransport = (opts: ChatOpts) => Promise<ChatResult>;
export type RerankTransport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Test-only transport overrides. A null entry means the SDK (or `fetch`) answers; an engine state's null entry falls
 * back to the process-wide override before the SDK, so a stub installed once reaches every engine. Production never
 * sets one.
 */
export interface GatewayTransports {
  embed: EmbedManyFn | null;
  generateText: GenerateTextFn | null;
  generateObject: GenerateObjectFn | null;
  chat: ChatTransport | null;
  rerank: RerankTransport | null;
  decide: RerankTransport | null;
}

export interface GatewayState {
  /** The configuration in effect; null until configured. */
  config: AIGatewayConfig | null;
  /** Provider clients by touchpoint, recipe, model and base URL; cleared whenever `config` changes. */
  modelCache: Map<string, unknown>;
  /** The engine `reconfigureGatewayWithEngine` resolved models from, re-resolved when OpenAI discovery changes a tier. */
  discoveryEngine: BrainEngine | null;
  /** The one OpenAI model discovery run per reconfigure (gateway.ts `discoverBeforeOpenAICall`). */
  discovery: Promise<void> | null;
  transports: GatewayTransports;
  /** Part of every query-embedding cache key, so a cached vector is only ever served to the state that embedded it. */
  cacheScope: string;
}

let scopes = 0;

export function newGatewayState(cacheScope = `engine:${++scopes}`): GatewayState {
  return {
    config: null,
    modelCache: new Map(),
    discoveryEngine: null,
    discovery: null,
    transports: { embed: null, generateText: null, generateObject: null, chat: null, rerank: null, decide: null },
    cacheScope,
  };
}

/** Back to unconfigured: no config, no clients, no discovery, no transport overrides. The cache scope is kept. */
export function resetGatewayState(state: GatewayState): void {
  state.config = null;
  state.modelCache.clear();
  state.discoveryEngine = null;
  state.discovery = null;
  state.transports = { embed: null, generateText: null, generateObject: null, chat: null, rerank: null, decide: null };
}

/** The state of a process that configures the gateway once: `configureGateway` writes it, calls outside a scope read it. */
export const processGatewayState: GatewayState = newGatewayState('process');

let engineStates = new WeakMap<object, GatewayState>();

/** Records `state` as what calls scoped to `engine` read. */
export function recordEngineGatewayState(engine: object, state: GatewayState): void {
  engineStates.set(engine, state);
}

/** The state recorded for `engine` (or for the engine a view or transaction stands for), else undefined. */
export function gatewayStateFor(engine: object): GatewayState | undefined {
  return engineOwned(engineStates, engine);
}

/** The state the current call reads: the scoped engine's when one was recorded, else the process-wide one. */
export function currentGatewayState(): GatewayState {
  const engine = engineInScope();
  return (engine && gatewayStateFor(engine)) || processGatewayState;
}

/** Forgets every per-engine state (the gateway reset paths). */
export function dropEngineGatewayStates(): void {
  engineStates = new WeakMap();
}
