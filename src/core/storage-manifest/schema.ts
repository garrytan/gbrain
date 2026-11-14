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
import { opError, OperationError } from '../ops/contract.ts';
import { scanTextSpans } from '../secret-scan.ts';
import { canonicalJson } from '../remediation-step.ts';
import { LABEL_KEYS } from '../persistence/label-edit.ts';

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

/** The keys each object in a card takes, by dotted path with `*` for a list index (adopt maps draft records onto them). */
export const CARD_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  '': new Set(Object.keys(CardInputSchema.shape)),
  'locations.*': new Set(Object.keys(LocationSchema.shape)),
  restore: new Set(Object.keys(RestoreSchema.shape)),
  'restores.*': new Set(Object.keys(RestoreEventSchema.shape)),
};

export type CardInput = z.infer<typeof CardInputSchema>;
export type Card = CardInput & { registered_by: string; origin: (typeof ORIGINS)[number] };

const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'exec', 'shell', 'instructions']);
export const STAMPED_KEYS = ['registered_by', 'origin'] as const;
const CREDENTIAL_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CRED|AUTH)/i;
const CREDENTIAL_KEY = /(?:^|_)(?:password|passwd|passphrase|secret|token|credentials?|(?:api|access|secret|application|account|private|auth|master|encryption)_?key)(?:_|$)/;
const REFERENCE_KEY = /_(?:env|var|variable|file|path|name|ref|id)$/;
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]{1,}=\S/;
const VAR_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i;
const PRESIGNED = /(?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Authorization=|[?&](?:token|sig|signature|access_token)=)/i;

function invalid(path: string, message: string, reason: string): OperationError {
  return opError('storage_record_invalid', `Storage card field ${path || '(card)'}: ${message}; nothing was written.`,
    'Fix that field and send the card again; gbrain storage-register --help shows the card fields.', { reason });
}

/** Every string in `value` and every object key, each with its path (command keys are refused wherever they appear). */
function walk(value: unknown, path: string, visit: (path: string, text: string) => void): void {
  if (typeof value === 'string') { visit(path, value); return; }
  if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (isCommandKey(key)) throw invalid(at, 'a card carries no commands; restore runs through restore.skill and restore.args', 'command_field');
      if (holdsCredential(key, item)) throw credentialKeyRefusal(at);
      visit(`${path || '(card)'} (a key)`, key);
      walk(item, at, visit);
    }
  }
}

export type CredentialShape = 'secret_scanner' | 'env_assignment' | 'url_userinfo' | 'presigned_url' | 'credential_variable';

/** The credential-shape rules over one string: the shape it has, or null. */
export function credentialShape(value: string): CredentialShape | null {
  if (scanTextSpans(value).some((span) => span.finding !== null)) return 'secret_scanner';
  return ENV_ASSIGNMENT.test(value) ? 'env_assignment'
    : URL_USERINFO.test(value) ? 'url_userinfo'
    : PRESIGNED.test(value) ? 'presigned_url'
    : [...value.matchAll(VAR_REFERENCE)].some((m) => CREDENTIAL_NAME.test(m[1]!)) ? 'credential_variable' : null;
}

/** Keys a card refuses wherever they appear: a card carries no commands. */
export function isCommandKey(key: string): boolean {
  return COMMAND_KEYS.has(key.toLowerCase());
}

/** A non-empty string or number under a key named for a credential (password, application_key), unless the key names where it lives (password_file, token_env). */
export function holdsCredential(key: string, value: unknown): boolean {
  if (!(typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))) return false;
  const name = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  return CREDENTIAL_KEY.test(name) && !REFERENCE_KEY.test(name);
}

function credentialKeyRefusal(path: string): OperationError {
  return opError('storage_record_secret', `Storage card field ${path} is named for a credential and holds a value; nothing was written.`,
    'If it holds a credential, remove it: the restore skill reads credentials from its own environment (name the variable, e.g. token_env, instead). If it holds none (a count, a version, a date), rename the key so it ends in a suffix this rule passes: _id, _ref, _name, _path, _file, _env, _var or _variable (token_count becomes token_count_id, say).',
    { reason: 'credential_key' });
}

/** Throws storage_record_secret without echoing the value. */
function assertNoCredential(path: string, value: string): void {
  const shape = credentialShape(value);
  if (shape === 'secret_scanner') {
    throw opError('storage_record_secret', `Storage card field ${path} looks like it holds a secret; nothing was written.`,
      'Remove the secret from that field. Cards name where an item is and how to restore it; credentials stay in the environment of the skill that restores it.',
      { reason: 'secret_scanner' });
  }
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

/** A card without the fields gbrain stamps, validated again: what two copies of one card compare on. Null when it fails the schema. */
export function cardContent(card: Record<string, unknown>): CardInput | null {
  const { registered_by: _by, origin: _origin, ...content } = card;
  try { return parseCardInput(content); } catch (error) { if (error instanceof OperationError) return null; throw error; }
}

function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmpty);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, withoutEmpty(item)]));
}

/** Stable text of a card's content (null and absent fields are the same), for comparing and hashing. */
/** The page labels that decide who reads a page (visibility, its access and confidentiality aliases, readable_by). */
export const ACCESS_LABEL_KEYS: readonly string[] = [...LABEL_KEYS, 'readable_by'];
export type AccessLabels = Record<string, unknown>;

/** The access labels a page's frontmatter carries. */
export function accessLabels(frontmatter: Record<string, unknown>): AccessLabels {
  return Object.fromEntries(ACCESS_LABEL_KEYS.filter((key) => Object.hasOwn(frontmatter, key)).map((key) => [key, frontmatter[key]]));
}

/** An export line's `labels`: access label keys only, each a string (readable_by a reader or a list of readers). */
export function parseAccessLabels(value: unknown): AccessLabels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('labels', 'must be an object of access labels', 'labels');
  for (const [key, item] of Object.entries(value)) {
    if (!ACCESS_LABEL_KEYS.includes(key)) throw invalid(`labels.${key}`, `is not an access label (${ACCESS_LABEL_KEYS.join(', ')})`, 'labels');
    const ok = typeof item === 'string' || (key === 'readable_by' && Array.isArray(item) && item.length > 0 && item.every((r) => typeof r === 'string'));
    if (!ok) throw invalid(`labels.${key}`, key === 'readable_by' ? 'must be a reader or a list of readers' : 'must be a string', 'labels');
  }
  return value as AccessLabels;
}

export function cardDigest(card: CardInput): string {
  return canonicalJson(withoutEmpty(card));
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
