/**
 * The default registration profile setup and `bootstrap hooks` give a harness, with Codex's
 * `mcp.allow_session_widen` read the way `gbrain serve` reads it: the brain database first, then the config file.
 * Both commands are otherwise engine-free, so the database read is short, read-only and best effort. When it cannot
 * open the brain (a running gbrain server holds the PGLite lock, Postgres does not answer) and the config file would
 * register full, Codex never gets a new full registration: a new one gets starter, an existing one stays as it is,
 * and a note names the setting.
 */
import { existsSync } from 'node:fs';
import { toEngineConfig, type GBrainConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import { profileFlags, registrationProfile, STARTER_PROFILE, type RegistrationHarness, type RegistrationProfile } from '../core/mcp-registration.ts';

export const CODEX_DEFAULT_WHY = 'Codex does not reload its tool list, so a tool request_tools unlocks stays uncallable there';
const WIDEN_OFF_WHY = 'session widening is off on this brain (mcp.allow_session_widen), so request_tools cannot unlock tools there';
const READ_TIMEOUT_MS = 1500;

export type DbWidenRead = { value: string | null } | { unreadable: string };

/** `mcp.allow_session_widen` from the brain database, read-only. `value: null`: no database yet, no row, or a failed read (serve then uses the file too). */
export async function readSessionWidenDb(cfg: GBrainConfig, timeoutMs = READ_TIMEOUT_MS): Promise<DbWidenRead> {
  const config = toEngineConfig(cfg);
  const local = Boolean(config.database_path);
  if (config.database_path && !existsSync(config.database_path)) return { value: null };
  const { constructEngine } = await import('../core/engine-construct.ts');
  const engine = await constructEngine(config);
  const held = engine as unknown as { connectWithHeldLock?(c: EngineConfig, l: unknown): Promise<void> };
  try {
    if (config.database_path && held.connectWithHeldLock) {
      const { acquireLock, releaseLock } = await import('../core/pglite-lock.ts');
      const lock = await acquireLock(config.database_path, { timeoutMs });
      try { await held.connectWithHeldLock(config, lock); } catch (e) { await releaseLock(lock); throw e; }
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
      try { await Promise.race([engine.connect(config), late]); } finally { clearTimeout(timer); }
    }
  } catch (e) {
    await engine.disconnect().catch(() => undefined);
    const busy = (e as { code?: string }).code === 'pglite_busy';
    return { unreadable: busy ? 'another gbrain process, such as a running Codex server, holds the brain' : local ? 'the brain could not be opened' : 'the brain database did not answer' };
  }
  try { return { value: await engine.getConfig('mcp.allow_session_widen') }; }
  catch { return { value: null }; }
  finally { await engine.disconnect().catch(() => undefined); }
}

/**
 * The profile a `harness` registration gets when the user chose none, and why (for setup's move notes). For Codex
 * with no `mcp.default_surface_codex` knob, `probe` reads the database setting; `keep` is the registration that
 * stays when it cannot be read.
 */
export async function harnessDefaultProfile(harness: RegistrationHarness, cfg: GBrainConfig | null,
  o: { note: (line: string) => void; probe: boolean; keep?: RegistrationProfile | null }, read = readSessionWidenDb): Promise<{ profile: RegistrationProfile; why: string }> {
  const file = registrationProfile(harness, cfg);
  const knob = cfg?.mcp?.default_surface_codex;
  if (harness !== 'codex') return { profile: file, why: '' };
  if (knob === 'full' || knob === 'starter') return { profile: file, why: `mcp.default_surface_codex is ${knob}` };
  const why = (p: RegistrationProfile) => p.surface === 'full' ? CODEX_DEFAULT_WHY : WIDEN_OFF_WHY;
  if (!cfg || !o.probe) return { profile: file, why: why(file) };
  const db = await read(cfg);
  if ('value' in db) {
    const profile = db.value === null ? file : registrationProfile('codex', { ...cfg, mcp: { ...cfg.mcp, allow_session_widen: db.value } });
    return { profile, why: why(profile) };
  }
  if (file.surface !== 'full') return { profile: file, why: why(file) };
  const profile = o.keep ? { ...o.keep } : { ...STARTER_PROFILE };
  o.note(`setup could not read mcp.allow_session_widen from the brain database (${db.unreadable}), so ${o.keep ? 'the Codex registration stays' : 'Codex registers'} serve ${profileFlags(profile).join(' ')} (pin it with --surface starter --advertise verbs); run setup again once nothing holds the brain to apply that setting.`);
  return { profile, why: 'setup could not read mcp.allow_session_widen from the brain database' };
}
