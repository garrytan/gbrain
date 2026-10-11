/**
 * 产品经理能看懂的测试说明：
 * 用本机已经配好的模型，把一份带日期的中文记录交给深度整理。
 * 整理完成后要有张三、星河科技、智慧水务这些实体，
 * 至少一条实体和实体之间的关系，每个实体都链回原文，
 * 并且同一天的这件事出现在不止一个实体的时间线上。
 * 再放进第二份记录：张三离开星河科技，当前在北海数据任职。
 * 张三页上只能有一节当前状态，而且写的是北海数据。
 * 测试用临时库，不打开正在使用的资料库。
 * 日常串行测试不调用模型。单独跑的时候设置 PMBRAIN_LIVE_GRAPH=1。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const LIVE = process.env.PMBRAIN_LIVE_GRAPH === '1';
const USER_CONFIG = 'C:\\Users\\zhengyunhui\\.pmbrain\\config.json';

test.skipIf(!LIVE)('真实模型生成实体、实体间关系、原文回链、时间线和当前状态', async () => {
  if (!existsSync(USER_CONFIG)) throw new Error('找不到本机模型配置，不能把这次当成完成');
  const home = join(tmpdir(), `pmbrain-live-graph-${Date.now()}`);
  const brainDir = join(home, '.pmbrain');
  mkdirSync(brainDir, { recursive: true });
  const parsed = JSON.parse(readFileSync(USER_CONFIG, 'utf8')) as Record<string, unknown>;
  delete parsed.database_url;
  delete parsed.database_path;
  parsed.engine = 'pglite';
  writeFileSync(join(brainDir, 'config.json'), JSON.stringify(parsed));
  process.env.PMBRAIN_HOME = home;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.PMBRAIN_DATABASE_URL;
  delete process.env.GBRAIN_HOME;

  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const { runPhaseCaptureEntities } = await import('../src/core/cycle/capture-entities.ts');
  const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
  const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
  const { buildGatewayConfig } = await import('../src/core/ai/gateway-config.ts');
  const { loadConfig } = await import('../src/core/config.ts');
  const config = loadConfig();
  if (!config) throw new Error('找不到本机模型配置，不能把这次当成完成');
  configureGateway(buildGatewayConfig(config));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    await resetPgliteState(engine);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('vault', 'Vault') ON CONFLICT (id) DO NOTHING`);
    await engine.setConfig('version', '130');

    await engine.putPage('notes/job-2026-03', {
      type: 'note',
      title: '到任记录',
      compiled_truth: '2026-03-01，张三在星河科技任职，负责智慧水务项目。',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'vault' });
    const first = await runPhaseCaptureEntities(engine, { sourceId: 'vault' });
    const firstPages = await entityPages(engine);
    if (first.status === 'fail') {
      throw new Error(`第一次整理没有完成：${first.summary}\n任务错误：${await failedJobText(engine)}\n已有标题：${titlesOf(firstPages)}`);
    }
    const zhang = byTitle(firstPages, '张三');
    const xinghe = byTitle(firstPages, '星河科技');
    const shuiwu = byTitle(firstPages, '智慧水务');
    expect(zhang, `第一次没有张三。${first.summary} 标题：${titlesOf(firstPages)}`).toBeTruthy();
    expect(xinghe, `第一次没有星河科技。${first.summary} 标题：${titlesOf(firstPages)}`).toBeTruthy();
    expect(shuiwu, `第一次没有智慧水务。${first.summary} 标题：${titlesOf(firstPages)}`).toBeTruthy();
    for (const page of [zhang!, xinghe!, shuiwu!]) {
      expect(page.compiled_truth, `${page.title} 没有链回原文`).toContain('notes/job-2026-03');
    }
    const edges = await entityEdges(engine);
    const typed = edges.filter(edge => edge.link_type !== 'mentions');
    expect(typed.length, `没有实体间的类型化关系。现有边：${JSON.stringify(edges)}`).toBeGreaterThan(0);
    const shared = await sharedTimeline(engine, [zhang!.slug, xinghe!.slug, shuiwu!.slug]);
    expect(shared.some(row => row.date.startsWith('2026-03-01') && row.pages >= 2), `时间线没有发到多个实体：${JSON.stringify(shared)}`).toBe(true);

    await engine.putPage('notes/job-2026-06', {
      type: 'note',
      title: '调动记录',
      compiled_truth: '2026-06-01，张三离开星河科技，当前在北海数据任职。',
      timeline: '',
      frontmatter: {},
    }, { sourceId: 'vault' });
    const second = await runPhaseCaptureEntities(engine, { sourceId: 'vault' });
    const secondPages = await entityPages(engine);
    if (second.status === 'fail') {
      throw new Error(`第二次整理没有完成：${second.summary}\n任务错误：${await failedJobText(engine)}\n已有标题：${titlesOf(secondPages)}`);
    }
    const person = await pageBySlug(engine, zhang!.slug);
    const beihai = secondPages.find(page => page.title.includes('北海数据'))
      ?? await pageBySlug(engine, 'companies/beihai-shuju');
    const listing = await listPages(engine);
    expect(person, `第二次后找不到 ${zhang!.slug}。${second.summary}\n页面：${listing}`).toBeTruthy();
    expect(person!.title.includes('张三') || person!.compiled_truth.includes('张三'), `人物页不再是张三。type=${person!.type} title=${person!.title}\n${person!.compiled_truth}`).toBe(true);
    expect(beihai, `第二次没有北海数据。${second.summary}\n页面：${listing}`).toBeTruthy();
    expect(beihai!.compiled_truth, '北海数据没有链回调动记录').toContain('notes/job-2026-06');
    const state = currentState(person!.compiled_truth);
    expect(state.headings, `当前状态不是一节：\n${person!.compiled_truth}`).toBe(1);
    expect(state.text, `当前状态里没有北海数据：\n${state.text}`).toContain('北海数据');
  } finally {
    resetGateway();
    await engine.disconnect().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 480_000);

interface EntityRow {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
}

async function pageBySlug(
  engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> },
  slug: string,
): Promise<EntityRow | undefined> {
  const rows = await engine.executeRaw<EntityRow>(
    `SELECT slug, type, title, compiled_truth
       FROM pages
      WHERE source_id = 'vault' AND slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
  return rows[0];
}

async function listPages(engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }): Promise<string> {
  const rows = await engine.executeRaw<{ slug: string; type: string; title: string }>(
    `SELECT slug, type, title FROM pages WHERE deleted_at IS NULL ORDER BY slug`,
  );
  return rows.map(row => `${row.type}:${row.slug}:${row.title}`).join('、') || '无';
}

async function entityPages(engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }): Promise<EntityRow[]> {
  return engine.executeRaw<EntityRow>(
    `SELECT slug, type, title, compiled_truth
       FROM pages
      WHERE source_id = 'vault'
        AND type IN ('person', 'company', 'organization', 'project', 'concept')
      ORDER BY slug`,
  );
}

function titlesOf(pages: EntityRow[]): string {
  return pages.map(page => `${page.type}:${page.title}`).join('、') || '无';
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{8,}\b/g, '[redacted]');
}

async function failedJobText(engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }): Promise<string> {
  const jobs = await engine.executeRaw<{ error_text: string | null }>(
    `SELECT error_text FROM minion_jobs WHERE COALESCE(error_text, '') <> '' ORDER BY id`,
  );
  const text = jobs.map(job => redact(job.error_text ?? '')).filter(Boolean).join(' | ');
  return text || '无';
}

function byTitle(pages: EntityRow[], needle: string): EntityRow | undefined {
  return pages.find(page => page.title.includes(needle));
}

async function entityEdges(engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> }): Promise<Array<{ from_slug: string; to_slug: string; link_type: string }>> {
  return engine.executeRaw(
    `SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.source_id = 'vault'
        AND t.source_id = 'vault'
        AND f.type IN ('person', 'company', 'organization', 'project', 'concept')
        AND t.type IN ('person', 'company', 'organization', 'project', 'concept')
      ORDER BY l.link_type, f.slug, t.slug`,
  );
}

async function sharedTimeline(
  engine: { getTimeline(slug: string, opts?: { sourceId?: string }): Promise<Array<{ date: unknown; summary: string }>> },
  slugs: string[],
): Promise<Array<{ date: string; summary: string; pages: number }>> {
  const counts = new Map<string, { date: string; summary: string; pages: number }>();
  for (const slug of slugs) {
    const entries = await engine.getTimeline(slug, { sourceId: 'vault' });
    const seen = new Set<string>();
    for (const entry of entries) {
      const date = entry.date instanceof Date
        ? `${entry.date.getFullYear()}-${String(entry.date.getMonth() + 1).padStart(2, '0')}-${String(entry.date.getDate()).padStart(2, '0')}`
        : String(entry.date).slice(0, 10);
      const key = `${date}\0${entry.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = counts.get(key) ?? { date, summary: entry.summary, pages: 0 };
      row.pages += 1;
      counts.set(key, row);
    }
  }
  return [...counts.values()];
}

function currentState(markdown: string): { headings: number; text: string } {
  const lines = markdown.split('\n');
  const heads = lines
    .map((line, index) => ({ line, index }))
    .filter(item => /^(#{2})[ \t]+(?:State|当前状态)[ \t]*$/i.test(item.line));
  if (heads.length !== 1) return { headings: heads.length, text: markdown };
  const start = heads[0]!.index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^(#{1,2})[ \t]/.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return { headings: 1, text: lines.slice(start, end).join('\n') };
}
