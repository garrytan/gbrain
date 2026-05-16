import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import {
  CompanyShareError,
  appendCompanyShareAudit,
  buildCompanyShareExport,
  getCompanyShareRole,
  importCompanyShareRecords,
  loadCompanyShareMembers,
  normalizeShareMode,
  removeCompanyShareMember,
  setCompanyShareSecret,
  setPageShareMode,
  setSourceShareDefault,
  upsertCompanyShareMember,
  validateMemberId,
  verifyCompanyShareExport,
  type CompanyShareExport,
  type CompanyShareMember,
} from '../core/company-share.ts';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    throw new CompanyShareError('missing_flag_value', `${name} requires a value.`);
  }
  return value;
}

function readMode(args: string[]): ReturnType<typeof normalizeShareMode> {
  const raw = readFlag(args, '--mode') ?? readFlag(args, '--default');
  if (!raw) throw new CompanyShareError('missing_mode', 'Expected --mode private|summary|full or --default private|summary|full.');
  const mode = normalizeShareMode(raw);
  if (mode === 'private' && raw !== 'private') {
    throw new CompanyShareError('invalid_mode', 'Mode must be private, summary, or full.');
  }
  return mode;
}

function printJsonOrText(json: boolean, value: unknown, text: string): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(text);
  }
}

function renderCompanyShareError(err: unknown): never {
  if (err instanceof CompanyShareError) {
    console.error(`Error [${err.code}]: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

async function runSecret(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub !== 'set') {
    console.error('Usage: gbrain company-share secret set [--secret <shared-secret>] [--json]');
    process.exit(2);
  }
  const json = hasFlag(rest, '--json');
  const secret = await setCompanyShareSecret(engine, readFlag(rest, '--secret'));
  printJsonOrText(json, { status: 'ok', secret }, `Company-share manifest secret configured.\nSecret: ${secret}`);
}

async function runSetSource(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args[0];
  if (!sourceId) {
    console.error('Usage: gbrain company-share set-source <source-id> --default private|summary|full [--json]');
    process.exit(2);
  }
  const json = hasFlag(args, '--json');
  const result = await setSourceShareDefault(engine, sourceId, readMode(args));
  printJsonOrText(json, result, `Source "${result.source_id}" company-share default set to ${result.mode}.`);
}

async function runSetPage(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: gbrain company-share set-page <slug> --mode private|summary|full [--source <id>] [--json]');
    process.exit(2);
  }
  const json = hasFlag(args, '--json');
  const sourceId = readFlag(args, '--source') ?? 'default';
  const result = await setPageShareMode(engine, slug, readMode(args), sourceId);
  printJsonOrText(json, result, `Page "${result.source_id}:${result.slug}" company-share mode set to ${result.mode}.`);
}

async function runExport(engine: BrainEngine, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const limitRaw = readFlag(args, '--limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const cursor = readFlag(args, '--cursor');
  const sourceId = readFlag(args, '--source');
  const memberId = readFlag(args, '--member-id');
  const exported = await buildCompanyShareExport(engine, { limit, cursor, sourceId, memberId });
  if (json) {
    console.log(JSON.stringify(exported, null, 2));
  } else {
    console.log(`Exported ${exported.records.length} shared page(s).`);
    if (exported.next_cursor) console.log(`Next cursor: ${exported.next_cursor}`);
  }
}

function memberRemoteConfig(member: CompanyShareMember): GBrainConfig {
  return {
    engine: 'postgres',
    remote_mcp: {
      issuer_url: member.issuer_url,
      mcp_url: member.mcp_url,
      oauth_client_id: member.oauth_client_id,
      ...(member.oauth_client_secret ? { oauth_client_secret: member.oauth_client_secret } : {}),
    },
  };
}

async function fetchAllMemberExports(member: CompanyShareMember, limit: number): Promise<CompanyShareExport[]> {
  const exports: CompanyShareExport[] = [];
  let cursor: string | null | undefined;
  do {
    const raw = await callRemoteTool(
      memberRemoteConfig(member),
      'company_share_export',
      {
        member_id: member.id,
        limit,
        ...(cursor ? { cursor } : {}),
      },
      { timeoutMs: 60_000 },
    );
    const exported = unpackToolResult<CompanyShareExport>(raw);
    verifyCompanyShareExport(exported, member);
    exports.push(exported);
    cursor = exported.next_cursor;
  } while (cursor);
  return exports;
}

async function runMembers(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');

  if (sub === 'add') {
    const id = rest[0];
    if (!id) {
      console.error('Usage: gbrain company-share members add <id> --issuer-url <url> --mcp-url <url> --oauth-client-id <id> [--oauth-client-secret <secret>] --manifest-secret <secret> [--json]');
      process.exit(2);
    }
    const member = upsertCompanyShareMember({
      id,
      issuerUrl: readFlag(rest, '--issuer-url') ?? '',
      mcpUrl: readFlag(rest, '--mcp-url') ?? '',
      oauthClientId: readFlag(rest, '--oauth-client-id') ?? '',
      oauthClientSecret: readFlag(rest, '--oauth-client-secret'),
      manifestSecret: readFlag(rest, '--manifest-secret') ?? '',
    });
    printJsonOrText(json, { status: 'ok', member: { ...member, oauth_client_secret: member.oauth_client_secret ? 'stored' : undefined, manifest_secret: 'stored' } }, `Member "${member.id}" registered.`);
    return;
  }

  if (sub === 'list') {
    const members = loadCompanyShareMembers().members.map(m => ({
      id: m.id,
      issuer_url: m.issuer_url,
      mcp_url: m.mcp_url,
      oauth_client_id: m.oauth_client_id,
      has_oauth_client_secret: !!m.oauth_client_secret,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }));
    if (json) {
      console.log(JSON.stringify({ members }, null, 2));
    } else if (members.length === 0) {
      console.log('No company-share members registered.');
    } else {
      for (const member of members) {
        console.log(`${member.id}\t${member.mcp_url}\t${member.oauth_client_id}`);
      }
    }
    return;
  }

  if (sub === 'remove') {
    const id = rest[0];
    if (!id) {
      console.error('Usage: gbrain company-share members remove <id> [--json]');
      process.exit(2);
    }
    const removed = removeCompanyShareMember(id);
    printJsonOrText(json, { status: removed ? 'removed' : 'not_found', id }, removed ? `Member "${id}" removed.` : `Member "${id}" not found.`);
    return;
  }

  console.error('Usage: gbrain company-share members add|list|remove ...');
  process.exit(2);
}

async function runPull(engine: BrainEngine, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const memberFilter = readFlag(args, '--member');
  const limitRaw = readFlag(args, '--limit');
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : 100;
  const role = await getCompanyShareRole(engine);
  if (role !== 'company') {
    throw new CompanyShareError('wrong_role', 'company-share pull must run against a company-mode brain.');
  }
  if (memberFilter) validateMemberId(memberFilter);
  const members = loadCompanyShareMembers().members.filter(m => !memberFilter || m.id === memberFilter);
  if (members.length === 0) {
    throw new CompanyShareError('member_not_found', memberFilter ? `No member registered with id "${memberFilter}".` : 'No company-share members registered.');
  }

  const results = [];
  for (const member of members) {
    const exports = await fetchAllMemberExports(member, limit);
    const result = await importCompanyShareRecords(engine, member.id, exports);
    appendCompanyShareAudit({ event: 'pull', member_id: member.id, result });
    results.push(result);
  }
  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.member_id}: imported ${result.imported}, soft-deleted ${result.soft_deleted} in source ${result.source_id}`);
    }
  }
}

async function runSkillPolicy(engine: BrainEngine, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const role = await getCompanyShareRole(engine);
  if (role === 'company') {
    const { companySkillProfile } = await import('../core/company-skill-policy.ts');
    const profile = companySkillProfile();
    if (json) {
      console.log(JSON.stringify(profile, null, 2));
      return;
    }
    console.log('Company skill profile');
    console.log(`Resolver: ${profile.resolver}`);
    console.log(`Enabled: ${profile.enabled.join(', ')}`);
    console.log(`Admin-only: ${profile.admin_only.join(', ')}`);
    console.log(`Disabled: ${profile.disabled.join(', ')}`);
    return;
  }

  const value = {
    role: 'individual',
    resolver: 'skills/RESOLVER.md',
    note: 'Individual brains use the full personal skill resolver.',
  };
  printJsonOrText(json, value, `${value.note}\nResolver: ${value.resolver}`);
}

function printHelp(): void {
  console.log(`gbrain company-share — opt-in individual-to-company sharing

Individual brain:
  gbrain company-share secret set [--secret <shared-secret>]
  gbrain company-share set-source <source-id> --default private|summary|full
  gbrain company-share set-page <slug> --mode private|summary|full [--source <id>]
  gbrain company-share export --json [--member-id <id>] [--limit <n>] [--cursor <token>]

Company brain:
  gbrain company-share members add <id> --issuer-url <url> --mcp-url <url> --oauth-client-id <id> [--oauth-client-secret <secret>] --manifest-secret <secret>
  gbrain company-share members list [--json]
  gbrain company-share members remove <id>
  gbrain company-share pull [--member <id>] [--json]
  gbrain company-share skill-policy [--json]
`);
}

export async function runCompanyShare(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'secret': return runSecret(engine, rest);
      case 'set-source': return runSetSource(engine, rest);
      case 'set-page': return runSetPage(engine, rest);
      case 'export': return runExport(engine, rest);
      case 'members': return runMembers(rest);
      case 'pull': return runPull(engine, rest);
      case 'skill-policy': return runSkillPolicy(engine, rest);
      case undefined:
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        console.error(`Unknown company-share subcommand: ${sub}`);
        printHelp();
        process.exit(2);
    }
  } catch (err) {
    renderCompanyShareError(err);
  }
}
