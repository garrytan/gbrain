/**
 * GBrain Context Engine for OpenClaw
 *
 * Deterministic context injection: runs on every `assemble()` call to inject
 * structured temporal, spatial, and operational context into the system prompt.
 *
 * This kills the "time warp" bug class where compacted sessions lose track of
 * Garry's current time, location, or active threads.
 *
 * Architecture: delegates compaction to the legacy runtime. Only owns
 * `systemPromptAddition` injection during `assemble()`. Zero LLM calls.
 *
 * @see https://docs.openclaw.ai/concepts/context-engine
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
// Types inlined from openclaw/plugin-sdk to avoid hard dependency during development.
// At runtime inside OpenClaw, the real SDK is available; these types ensure build compat.

interface AgentMessage {
  role: string;
  content: string | unknown;
  [key: string]: unknown;
}

interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
}

interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: Record<string, unknown>;
}

interface IngestResult {
  ingested: boolean;
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;
  ingest(params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>;
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: string;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    [key: string]: unknown;
  }): Promise<CompactResult>;
}

// Runtime helpers — loaded dynamically when running inside OpenClaw.
// When running standalone (tests, dev), we use fallbacks.
let _delegateCompactionToRuntime: ((params: any) => Promise<CompactResult>) | undefined;
let _buildMemorySystemPromptAddition: ((params: any) => string | undefined) | undefined;

try {
  const sdk = await import('openclaw/plugin-sdk/core');
  _delegateCompactionToRuntime = sdk.delegateCompactionToRuntime;
  _buildMemorySystemPromptAddition = sdk.buildMemorySystemPromptAddition;
} catch {
  // Not running inside OpenClaw — use fallbacks
  _delegateCompactionToRuntime = async () => ({ ok: true, compacted: false, reason: 'no-runtime' });
  _buildMemorySystemPromptAddition = () => undefined;
}

export const ENGINE_ID = 'gbrain-context';
export const ENGINE_NAME = 'GBrain Context Engine';
export const ENGINE_VERSION = '0.1.0';

// ── Helpers ─────────────────────────────────────────────────────────────

function loadJsonFile<T = unknown>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Common airport → timezone mapping */
const AIRPORT_TZ: Record<string, string> = {
  SFO: 'US/Pacific', LAX: 'US/Pacific', SJC: 'US/Pacific', SEA: 'US/Pacific', PDX: 'US/Pacific',
  JFK: 'US/Eastern', LGA: 'US/Eastern', EWR: 'US/Eastern', BOS: 'US/Eastern',
  DCA: 'US/Eastern', IAD: 'US/Eastern', MIA: 'US/Eastern', ATL: 'US/Eastern',
  ORD: 'US/Central', DFW: 'US/Central', IAH: 'US/Central', AUS: 'US/Central',
  DEN: 'US/Mountain', PHX: 'US/Arizona',
  HNL: 'Pacific/Honolulu',
  YYZ: 'America/Toronto', YVR: 'America/Vancouver', YUL: 'America/Montreal',
  NRT: 'Asia/Tokyo', HND: 'Asia/Tokyo', ICN: 'Asia/Seoul',
  SIN: 'Asia/Singapore', HKG: 'Asia/Hong_Kong', TPE: 'Asia/Taipei',
  LHR: 'Europe/London', CDG: 'Europe/Paris', FCO: 'Europe/Rome',
  LIS: 'Europe/Lisbon', BCN: 'Europe/Madrid',
};

const DEFAULT_TZ = 'US/Pacific';
const DEFAULT_HOME = 'San Francisco';

// ── Types ───────────────────────────────────────────────────────────────

interface HeartbeatState {
  garryAwake?: boolean;
  garryAwokeAt?: string | null;
  currentLocation?: {
    city?: string;
    state?: string;
    province?: string;
    country?: string;
    timezone?: string;
    source?: string;
    note?: string;
  };
  lastChecks?: Record<string, string>;
  blockers?: Record<string, string>;
}

interface FlightData {
  flights?: Array<{
    status?: string;
    origin?: string;
    destination?: string;
    flightNumber?: string;
    note?: string;
  }>;
}

interface LiveContext {
  now: string;
  timezone: string;
  dayOfWeek: string;
  homeTime: string | null;
  location: {
    city: string;
    tz: string;
    source: string;
  };
  garryAwake: boolean;
  isQuietHours: boolean;
  activeTravel: string | null;
}

// ── Context Generation (deterministic, <5ms) ────────────────────────────

function getTimeInTz(tz: string): { iso: string; dayOfWeek: string; hour: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';

  const utcH = now.getUTCHours();
  const localH = parseInt(get('hour'));
  let offset = localH - utcH;
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const offsetStr = `${sign}${String(abs).padStart(2, '0')}:00`;

  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offsetStr}`;
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });

  return { iso, dayOfWeek, hour: localH };
}

function resolveLocation(workspaceDir: string): { city: string; tz: string; source: string } {
  const hb = loadJsonFile<HeartbeatState>(join(workspaceDir, 'memory', 'heartbeat-state.json'));
  if (hb?.currentLocation?.timezone) {
    return {
      city: hb.currentLocation.city ?? DEFAULT_HOME,
      tz: hb.currentLocation.timezone,
      source: hb.currentLocation.source ?? 'heartbeat',
    };
  }

  // Check flights
  const flights = loadJsonFile<FlightData>(join(workspaceDir, 'memory', 'upcoming-flights.json'));
  const active = flights?.flights?.find(f => f.status === 'active');
  if (active?.destination) {
    const tz = AIRPORT_TZ[active.destination.toUpperCase()] ?? DEFAULT_TZ;
    return { city: active.destination, tz, source: `flight:${active.flightNumber}` };
  }

  return { city: DEFAULT_HOME, tz: DEFAULT_TZ, source: 'default' };
}

function generateLiveContext(workspaceDir: string): LiveContext {
  const location = resolveLocation(workspaceDir);
  const time = getTimeInTz(location.tz);
  const hb = loadJsonFile<HeartbeatState>(join(workspaceDir, 'memory', 'heartbeat-state.json'));

  const garryAwake = hb?.garryAwake ?? true;
  const isQuietHours = !garryAwake && (time.hour >= 23 || time.hour < 8);

  // Home time when traveling
  let homeTime: string | null = null;
  if (location.tz !== DEFAULT_TZ && location.tz !== 'US/Pacific' && location.tz !== 'America/Los_Angeles') {
    const ptFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TZ,
      hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
    });
    homeTime = ptFmt.format(new Date()) + ' PT';
  }

  // Active travel
  const flights = loadJsonFile<FlightData>(join(workspaceDir, 'memory', 'upcoming-flights.json'));
  const activeFlight = flights?.flights?.find(f => f.status === 'active');
  const activeTravel = activeFlight
    ? `${activeFlight.flightNumber}: ${activeFlight.origin}→${activeFlight.destination}`
    : null;

  return {
    now: time.iso,
    timezone: location.tz,
    dayOfWeek: time.dayOfWeek,
    homeTime,
    location,
    garryAwake,
    isQuietHours,
    activeTravel,
  };
}

function formatContextBlock(ctx: LiveContext): string {
  const lines: string[] = [
    `## Live Context (deterministic, injected by gbrain-context engine)`,
    `- **Time:** ${ctx.now} (${ctx.timezone})`,
    `- **Day:** ${ctx.dayOfWeek}`,
    `- **Location:** ${ctx.location.city} (source: ${ctx.location.source})`,
  ];

  if (ctx.homeTime) {
    lines.push(`- **Home (SF):** ${ctx.homeTime}`);
  }
  if (ctx.activeTravel) {
    lines.push(`- **Active travel:** ${ctx.activeTravel}`);
  }
  if (!ctx.garryAwake) {
    lines.push(`- **Garry awake:** no (quiet hours ${ctx.isQuietHours ? 'active' : 'paused'})`);
  }

  lines.push('');
  lines.push('> This block is computed on every turn. Trust it over compaction summaries for time/location.');

  return lines.join('\n');
}

// ── Engine Implementation ───────────────────────────────────────────────

export function createGBrainContextEngine(ctx: {
  workspaceDir?: string;
}): ContextEngine {
  const workspaceDir = ctx.workspaceDir ?? process.cwd();

  const engine: ContextEngine = {
    info: {
      id: ENGINE_ID,
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      ownsCompaction: false,  // delegate to legacy runtime
    } satisfies ContextEngineInfo,

    async ingest({ message }) {
      // No-op — we don't index messages. The legacy engine handles persistence.
      return { ingested: true };
    },

    async assemble({ messages, tokenBudget, availableTools, citationsMode }) {
      // 1. Generate deterministic context (<5ms, zero LLM calls)
      const liveCtx = generateLiveContext(workspaceDir);
      const contextBlock = formatContextBlock(liveCtx);

      // 2. Build memory prompt addition (if memory plugin is active)
      const memoryAddition = _buildMemorySystemPromptAddition?.({
        availableTools: availableTools ?? new Set(),
        citationsMode,
      });

      // 3. Combine: live context + memory prompt
      const parts = [contextBlock];
      if (memoryAddition) parts.push(memoryAddition);

      // 4. Pass through messages unchanged (legacy assembly)
      return {
        messages,
        estimatedTokens: messages.reduce((sum, m) => {
          const text = typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content);
          return sum + Math.ceil(text.length / 4);
        }, 0),
        systemPromptAddition: parts.join('\n\n'),
      };
    },

    async compact(params) {
      // Delegate entirely to legacy runtime compaction
      return _delegateCompactionToRuntime?.(params) ?? { ok: true, compacted: false, reason: 'no-runtime' };
    },
  };

  return engine;
}
