/**
 * Value: protects=sources add --kind google accepts --access gbrainio as Gmail-only and refuses bad combos; fails_when=access/services/gbrainio-command checks are dropped or inverted; why_new=no test parses these flags; seam=none; no_claim=gbrainio terminal behaviour (parser only)
 * Value: protects=parseGoogleSourceConfig forces gmail-only, default command and ingest tiers for gbrainio; fails_when=a gbrainio source sweeps calendar/contacts or loses tiers; why_new=source-config has no gbrainio test; seam=none; no_claim=sync behaviour
 */
import { describe, expect, test } from 'bun:test';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { parseGoogleSourceConfig } from '../src/core/google/source-config.ts';

const add = (...extra: string[]) => parseSourceLifecycleArgs(['add', 'mail', '--kind', 'google', '--account', 'Alice@Example.com', ...extra]);

describe('sources add --access gbrainio', () => {
  test('defaults services to gmail and keeps the command and private-senders path', () => {
    const { params } = add('--access', 'gbrainio', '--gbrainio-command', ' /opt/gbrainio ', '--private-senders-file', 'senders.txt');
    const google = (params.options as { google: Record<string, unknown> }).google;
    expect(google).toMatchObject({ account: 'alice@example.com', services: ['gmail'], access: 'gbrainio', gbrainioCommand: '/opt/gbrainio' });
    expect(String(google.privateSendersFile)).toMatch(/^\/.*senders\.txt$/);
  });

  test('refuses non-gmail services, token flags, and --gbrainio-command without gbrainio access', () => {
    expect(() => add('--access', 'gbrainio', '--services', 'gmail,calendar')).toThrow(/Gmail only/);
    expect(() => add('--access', 'gbrainio', '--token-env', 'TOK')).toThrow();
    expect(() => add('--gbrainio-command', 'gbrainio')).toThrow();
    expect(() => add('--access', 'gbrainio', '--private-senders-file', '  ')).toThrow(/needs a path/);
  });
});

describe('parseGoogleSourceConfig with gbrainio access', () => {
  test('gmail only, default command, tiers on unless turned off', () => {
    const cfg = parseGoogleSourceConfig({ g_account: 'a@example.com', g_access: 'gbrainio', g_services: 'gmail,calendar,contacts' }, '/tmp/x');
    expect(cfg).toMatchObject({ access: 'gbrainio', services: ['gmail'], gbrainioCommand: 'gbrainio', ingestTiers: true });
    const off = parseGoogleSourceConfig({ g_account: 'a@example.com', g_access: 'gbrainio', g_ingest_tiers: false }, '/tmp/x');
    expect(off.ingestTiers).toBeUndefined();
    const vault = parseGoogleSourceConfig({ g_account: 'a@example.com' }, '/tmp/x');
    expect(vault.access).toBe('vault');
    expect(vault.ingestTiers).toBeUndefined();
    expect(vault.gbrainioCommand).toBeUndefined();
  });
});
