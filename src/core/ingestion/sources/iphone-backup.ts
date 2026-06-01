import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAuditDir } from '../../audit/audit-writer.ts';
import type {
  IngestionEvent,
  IngestionSource,
  IngestionSourceContext,
  IngestionSourceHealth,
  IngestionSourceMode,
} from '../types.ts';
import {
  CONTACTS_DOMAIN,
  CONTACTS_RELATIVE_PATH,
  IPhoneBackupManifest,
  SMS_DOMAIN,
  SMS_RELATIVE_PATH,
} from '../../iphone/manifest.ts';
import { openContactsDb, readContacts } from '../../iphone/contacts.ts';
import { buildNameResolver } from '../../iphone/name-resolver.ts';
import { openSmsDb, readSmsMessages, segmentMessagesByMonth } from '../../iphone/sms.ts';
import { renderConversationMarkdown, renderPersonMarkdown, type RenderedIPhonePage } from '../../iphone/render.ts';
import type { SqliteDatabaseLike } from '../../iphone/types.ts';

export interface IphoneBackupSourceOpts {
  backupDir: string;
  selfName?: string;
  dryRun?: boolean;
  limit?: number;
  maxMessages?: number;
  auditDir?: string;
  _existsSync?: (path: string) => boolean;
  _openManifest?: (backupDir: string) => IPhoneBackupManifest;
  _openDb?: (path: string) => SqliteDatabaseLike;
  _appendFileSync?: (path: string, content: string) => void;
}

export interface IphoneBackupStats {
  emitted: number;
  people: number;
  conversations: number;
  missingStores: number;
  failures: number;
  messagesCapped: number;
}

export class IphoneBackupSource implements IngestionSource {
  readonly id: string;
  readonly kind = 'iphone-backup';
  readonly mode: IngestionSourceMode = 'migration';

  private ctx: IngestionSourceContext | null = null;
  private readonly opts: Required<Omit<IphoneBackupSourceOpts, 'limit' | 'selfName' | 'maxMessages'>> & {
    limit: number | undefined;
    selfName: string;
    maxMessages: number | undefined;
  };
  private _stats: IphoneBackupStats = {
    emitted: 0,
    people: 0,
    conversations: 0,
    missingStores: 0,
    failures: 0,
    messagesCapped: 0,
  };

  constructor(opts: IphoneBackupSourceOpts) {
    this.id = `iphone-backup:${process.pid}`;
    this.opts = {
      backupDir: opts.backupDir,
      selfName: opts.selfName ?? 'Me',
      dryRun: opts.dryRun ?? false,
      limit: opts.limit,
      maxMessages: opts.maxMessages ?? 250_000,
      auditDir: opts.auditDir ?? resolveAuditDir(),
      _existsSync: opts._existsSync ?? existsSync,
      _openManifest: opts._openManifest ?? ((backupDir) => new IPhoneBackupManifest(backupDir)),
      _openDb: opts._openDb ?? ((path) => {
        if (path.endsWith('AddressBook.sqlitedb')) return openContactsDb(path);
        return openSmsDb(path);
      }),
      _appendFileSync: opts._appendFileSync ?? ((path, content) => {
        try {
          mkdirSync(dirname(path), { recursive: true });
        } catch {
          // best-effort audit directory creation
        }
        appendFileSync(path, content);
      }),
    };
  }

  get stats(): IphoneBackupStats {
    return { ...this._stats };
  }

  async start(ctx: IngestionSourceContext): Promise<void> {
    this.ctx = ctx;
    if (!this.opts._existsSync(this.opts.backupDir)) {
      throw new Error(`IphoneBackupSource: backup directory does not exist: ${this.opts.backupDir}`);
    }

    const manifest = this.opts._openManifest(this.opts.backupDir);
    try {
      const contacts = this.readContactsFromBackup(manifest);
      const resolver = buildNameResolver(contacts, { selfName: this.opts.selfName });
      const renderedPeople = uniquifyRenderedSlugs(contacts.map(renderPersonMarkdown));
      const renderedConversations = uniquifyRenderedSlugs(this.readConversationPagesFromBackup(manifest, resolver));

      for (const page of [...renderedPeople, ...renderedConversations]) {
        if (this.opts.limit !== undefined && this._stats.emitted >= this.opts.limit) break;
        this.emitPage(ctx, page);
      }
    } finally {
      manifest.close();
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async healthCheck(): Promise<IngestionSourceHealth> {
    if (this._stats.failures > 0 || this._stats.missingStores > 0 || this._stats.messagesCapped > 0) {
      return {
        status: 'warn',
        message: `${this._stats.failures} row failure(s), ${this._stats.missingStores} missing store(s), ${this._stats.messagesCapped} cap hit(s); check iphone-backup audit`,
      };
    }
    if (this._stats.emitted === 0 && !this.ctx) {
      return { status: 'warn', message: 'not yet started' };
    }
    return {
      status: 'ok',
      message: `${this._stats.emitted} page(s) emitted (${this._stats.people} people, ${this._stats.conversations} conversations)`,
    };
  }

  private readContactsFromBackup(manifest: IPhoneBackupManifest) {
    const ref = manifest.resolveFile(CONTACTS_DOMAIN, CONTACTS_RELATIVE_PATH);
    if (!ref) {
      this._stats.missingStores++;
      this.appendFailureAudit('contacts', CONTACTS_RELATIVE_PATH, 'AddressBook.sqlitedb not found in backup');
      return [];
    }
    const db = this.opts._openDb(ref.path);
    try {
      return readContacts(db);
    } catch (err) {
      this._stats.failures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.appendFailureAudit('contacts', ref.relativePath, msg);
      return [];
    } finally {
      db.close?.();
    }
  }

  private readConversationPagesFromBackup(
    manifest: IPhoneBackupManifest,
    resolver: ReturnType<typeof buildNameResolver>,
  ): RenderedIPhonePage[] {
    const ref = manifest.resolveFile(SMS_DOMAIN, SMS_RELATIVE_PATH);
    if (!ref) {
      this._stats.missingStores++;
      this.appendFailureAudit('sms', SMS_RELATIVE_PATH, 'sms.db not found in backup');
      return [];
    }
    const db = this.opts._openDb(ref.path);
    try {
      const messages = readSmsMessages(db, { limitMessages: this.opts.maxMessages });
      if (this.opts.maxMessages !== undefined && messages.length >= this.opts.maxMessages) {
        this._stats.messagesCapped++;
        this.appendFailureAudit('sms', ref.relativePath, `message cap reached at ${this.opts.maxMessages} row(s)`);
        return [];
      }
      return segmentMessagesByMonth(messages).map((segment) => renderConversationMarkdown(segment, resolver));
    } catch (err) {
      this._stats.failures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.appendFailureAudit('sms', ref.relativePath, msg);
      return [];
    } finally {
      db.close?.();
    }
  }

  private emitPage(ctx: IngestionSourceContext, page: RenderedIPhonePage): void {
    if (!this.opts.dryRun) {
      const event: IngestionEvent = {
        source_id: this.id,
        source_kind: this.kind,
        source_uri: `iphone-backup://${page.page_type}/${page.slug}`,
        received_at: new Date().toISOString(),
        content_type: 'text/markdown',
        content: page.content,
        content_hash: page.content_hash,
        untrusted_payload: false,
        metadata: {
          slug: page.slug,
          page_type: page.page_type,
          importer: 'iphone-backup',
        },
      };
      ctx.emit(event);
    }
    this._stats.emitted++;
    if (page.page_type === 'person') this._stats.people++;
    if (page.page_type === 'conversation') this._stats.conversations++;
  }

  private appendFailureAudit(store: string, path: string, error: string): void {
    const auditPath = join(this.opts.auditDir, `iphone-backup-failures-${isoWeekString(new Date())}.jsonl`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      importer: 'iphone-backup',
      store,
      path,
      error,
    });
    try {
      this.opts._appendFileSync(auditPath, line + '\n');
    } catch (err) {
      this.ctx?.logger.warn(
        `[iphone-backup] audit write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function isoWeekString(d: Date): string {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((+target - +yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function uniquifyRenderedSlugs(pages: RenderedIPhonePage[]): RenderedIPhonePage[] {
  const seen = new Map<string, number>();
  return pages.map((page) => {
    const count = seen.get(page.slug) ?? 0;
    seen.set(page.slug, count + 1);
    if (count === 0) return page;
    return { ...page, slug: `${page.slug}-${count + 1}` };
  });
}
