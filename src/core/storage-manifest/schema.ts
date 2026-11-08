/**
 * Storage manifest cards (GST-1943): one page per item an agent archived to object storage (B2, Supabase Storage, S3 and
 * similar), validated on every storage write. The card lives under the page's `storage` frontmatter key; `title` and
 * `aliases` are the page's own, so search and alias lookup index them like any page.
 *
 * A card never carries a credential or a command: string fields are secret-scanned and shape-checked (env assignments,
 * credential-named variables, URL userinfo, presigned-URL parameters), keys that name a command are refused anywhere in
 * the card, and `restore` is a structured `{ skill, args }` the agent's own restore skill runs. gbrain itself never
 * contacts a store.
 */
import { z } from 'zod';
import { opError, type OperationError } from '../ops/contract.ts';
import { scanTextSpans } from '../secret-scan.ts';

export const STORED_OBJECT_TYPE = 'stored-object';
export const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
export const STORES = ['b2', 'supabase', 's3', 'r2', 'gcs', 'other'] as const;
export const TOOLS = ['restic', 'object', 'rclone', 'other'] as const;
export const HASH_KINDS = ['sha256', 'sha256-tree-v1', 'b2-listing-sha1-v1', 'supabase-listing-etag-v1'] as const;
export const KINDS = ['directory', 'file', 'git-bundle', 'dataset', 'other'] as const;
export const STATUSES = ['archived', 'restored', 'missing', 'retired'] as const;
export const ORIGINS = ['local', 'adopt', 'import'] as const;
const RESTORES_KEPT = 20;
const DETAILS_MAX_BYTES = 64 * 1024;

const iso = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);
const count = z.number().int().nonnegative();

const LocationSchema = z.object({
  store: z.enum(STORES),
  bucket: text(200).nullish(),
  path: text(2000).min(1),
  tool: z.enum(TOOLS),
  repository: text(2000).nullish(),
  snapshot: text(200).nullish(),
  size_bytes: count,
  file_count: count.nullish(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  hash_kind: z.enum(HASH_KINDS).nullish(),
  verified_at: iso.nullish(),
}).strict();

const RestoreSchema = z.object({
  skill: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  args: z.record(z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/i), z.union([text(2000), z.number(), z.boolean()])).optional(),
}).strict();

const RestoreEventSchema = z.object({
  at: iso,
  to: text(2000).min(1),
  by: text(200).nullish(),
  verified: z.boolean(),
}).strict();

/** What a caller sends: every card field except the ones gbrain stamps. */
export const CardInputSchema = z.object({
  id: z.string().regex(CARD_ID_RE),
  title: text(300).min(1),
  aliases: z.array(text(200).min(1)).max(50).default([]),
  description: text(20_000).nullish(),
  kind: z.enum(KINDS),
  status: z.enum(STATUSES).default('archived'),
  locations: z.array(LocationSchema).min(1).max(20),
  original_path: text(2000).nullish(),
  on_source_machine: z.boolean().nullish(),
  source_machine: text(200).nullish(),
  archived_at: iso.nullish(),
  archived_by: text(200).nullish(),
  reason: text(2000).nullish(),
  restore: RestoreSchema,
  restores: z.array(RestoreEventSchema).max(RESTORES_KEPT).default([]),
  details: z.record(z.string(), z.unknown()).nullish(),
}).strict();

export type CardInput = z.infer<typeof CardInputSchema>;
export type Card = CardInput & { registered_by: string; origin: (typeof ORIGINS)[number] };

const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'exec', 'shell', 'instructions']);
const STAMPED_KEYS = ['registered_by', 'origin'] as const;
const CREDENTIAL_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CRED|AUTH)/i;
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]{1,}=\S/;
const VAR_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i;
const PRESIGNED = /(?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Authorization=|[?&](?:token|sig|signature|access_token)=)/i;

function invalid(path: string, message: string, reason: string): OperationError {
  return opError('storage_record_invalid', `Storage card field ${path || '(card)'}: ${message}; nothing was written.`,
    'Fix that field and send the card again; gbrain storage-register --help shows the card fields.', { reason });
}

/** Every string in `value` with its path, and every object key (command keys are refused wherever they appear). */
function walk(value: unknown, path: string, visit: (path: string, text: string) => void): void {
  if (typeof value === 'string') { visit(path, value); return; }
  if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (COMMAND_KEYS.has(key.toLowerCase())) throw invalid(at, 'a card carries no commands; restore runs through restore.skill and restore.args', 'command_field');
      walk(item, at, visit);
    }
  }
}

/** The credential-shape rules over one string. Throws without echoing the value. */
function assertNoCredential(path: string, value: string): void {
  if (scanTextSpans(value).some((span) => span.finding !== null)) {
    throw opError('storage_record_secret', `Storage card field ${path} looks like it holds a secret; nothing was written.`,
      'Remove the secret from that field. Cards name where an item is and how to restore it; credentials stay in the environment of the skill that restores it.',
      { reason: 'secret_scanner' });
  }
  const shape = ENV_ASSIGNMENT.test(value) ? 'env_assignment'
    : URL_USERINFO.test(value) ? 'url_userinfo'
    : PRESIGNED.test(value) ? 'presigned_url'
    : [...value.matchAll(VAR_REFERENCE)].some((m) => CREDENTIAL_NAME.test(m[1]!)) ? 'credential_variable' : null;
  if (shape) {
    throw opError('storage_record_secret', `Storage card field ${path} has a credential shape (${shape}); nothing was written.`,
      'Drop the environment assignment, credential variable, URL password or signed-URL parameter from that field; the restore skill reads credentials from its own environment.',
      { reason: shape });
  }
}

/** Validate a caller's card. Returns the parsed card; throws storage_record_invalid or storage_record_secret. */
export function parseCardInput(raw: unknown): CardInput {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw invalid('', 'the card must be a JSON object', 'not_json'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('', 'the card must be a JSON object', 'not_object');
  for (const key of STAMPED_KEYS) {
    if (Object.hasOwn(value, key)) throw invalid(key, 'gbrain sets this field itself', 'stamped_field');
  }
  walk(value, '', assertNoCredential);
  const details = (value as { details?: unknown }).details;
  if (details !== undefined && details !== null && Buffer.byteLength(JSON.stringify(details), 'utf8') > DETAILS_MAX_BYTES) {
    throw invalid('details', `details is over ${DETAILS_MAX_BYTES} bytes`, 'too_large');
  }
  const parsed = CardInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(issue.path.map(String).join('.'), issue.message, 'schema');
  }
  return parsed.data;
}

/** The card stored on a page: `title` and `aliases` from the page, the rest from its `storage` frontmatter key. */
export function cardFromPage(page: { slug: string; title: string; frontmatter: Record<string, unknown> }): Card | null {
  const stored = page.frontmatter.storage;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const aliases = Array.isArray(page.frontmatter.aliases) ? page.frontmatter.aliases.filter((a): a is string => typeof a === 'string') : [];
  return { ...(stored as Card), id: page.slug, title: page.title, aliases };
}

function summary(card: Card): string {
  const lines: string[] = [];
  if (card.description) lines.push(card.description.trim(), '');
  lines.push('## Where it is', '');
  for (const loc of card.locations) {
    const parts = [`${loc.store}${loc.bucket ? ` bucket ${loc.bucket}` : ''}`, `path ${loc.path}`];
    if (loc.repository) parts.push(`${loc.tool} repository ${loc.repository}`);
    if (loc.snapshot) parts.push(`snapshot ${loc.snapshot}`);
    parts.push(`${loc.size_bytes} bytes${loc.file_count != null ? `, ${loc.file_count} files` : ''}`);
    if (loc.verified_at) parts.push(`verified ${loc.verified_at}`);
    lines.push(`- ${parts.join(', ')}`);
  }
  lines.push('');
  if (card.original_path) lines.push(`Original path: ${card.original_path}`);
  if (card.reason) lines.push(`Reason: ${card.reason}`);
  if (card.archived_at) lines.push(`Archived: ${card.archived_at}${card.archived_by ? ` by ${card.archived_by}` : ''}`);
  lines.push(`Restore: ${card.restore.skill}${card.restore.args ? ` with ${Object.entries(card.restore.args).map(([k, v]) => `${k}=${String(v)}`).join(', ')}` : ''}`);
  return lines.join('\n') + '\n';
}

/** Frontmatter and body for a card's page. */
export function cardPage(card: Card): { frontmatter: Record<string, unknown>; body: string } {
  const { id: _id, title, aliases, ...rest } = card;
  return { frontmatter: { type: STORED_OBJECT_TYPE, title, ...(aliases.length ? { aliases } : {}), storage: rest }, body: summary(card) };
}

/** Newest first, capped. */
export function withRestore(card: Card, event: z.infer<typeof RestoreEventSchema>): Card {
  return { ...card, status: 'restored', restores: [event, ...card.restores].slice(0, RESTORES_KEPT) };
}
