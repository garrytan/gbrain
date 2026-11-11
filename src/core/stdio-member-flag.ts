/** GST-363: `gbrain serve --stdio-member <id>`, parsed and read back from a harness entry. Kept apart from mcp-registration.ts so serve and doctor import only this flag. */
import { ACCESS_ID_RE } from './access/principals.ts';

/**
 * GST-363: `serve --stdio-member <id>` binds one stdio server (the one harness entry that starts it) to one member.
 * It lives in that harness's own MCP entry, so it binds only that harness on this machine, on PGLite and Postgres
 * alike; config mcp.stdio_member, set by hand, is the brain-wide fallback for a serve started without it.
 */
export const STDIO_MEMBER_FLAG = '--stdio-member';

/** serve's --stdio-member value (either form), undefined when absent; a missing, repeated or ill-formed value throws. */
export function parseStdioMemberFlag(args: readonly string[]): string | undefined {
  const values: Array<string | undefined> = [];
  args.forEach((a, i) => {
    if (a === STDIO_MEMBER_FLAG) values.push(args[i + 1]);
    else if (a.startsWith(`${STDIO_MEMBER_FLAG}=`)) values.push(a.slice(STDIO_MEMBER_FLAG.length + 1));
  });
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new Error(`${STDIO_MEMBER_FLAG} was given ${values.length} times; pass one member id.`);
  const id = values[0];
  if (id === undefined || !ACCESS_ID_RE.test(id)) {
    throw new Error(`${STDIO_MEMBER_FLAG} needs a member id (lowercase letters, digits, '.', '_' or '-'; gbrain access member list names them). Got: ${id === undefined ? '(missing value)' : JSON.stringify(id)}`);
  }
  return id;
}

/** The member a registered serve entry's args bind (--stdio-member), or undefined when it binds none or names it ill-formed. */
export function registeredStdioMember(entry: unknown): string | undefined {
  const args = entry && typeof entry === 'object' && Array.isArray((entry as { args?: unknown }).args) ? (entry as { args: unknown[] }).args : null;
  if (!args || !args.includes('serve') || !args.every((a): a is string => typeof a === 'string')) return undefined;
  try { return parseStdioMemberFlag(args); } catch { return undefined; }
}

/** An owned entry's inspection with the member its args bind, so a rewrite carries it forward. */
export function withStdioMember<T extends { state: string }>(mcp: T, entry: unknown): T & { stdioMember?: string } {
  const stdioMember = registeredStdioMember(entry);
  return stdioMember === undefined ? mcp : { ...mcp, stdioMember };
}
