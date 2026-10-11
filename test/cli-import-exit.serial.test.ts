import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getRun,
  PgliteRunCoordinator,
  startImportRun,
} from '../src/commands/natural-lang/index.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PACKAGED_RUNTIME = join(REPO, 'desktop', 'build', 'extraResources', 'pmbrain-runtime');
const WINDOWS_RUNTIME_READY = process.platform === 'win32'
  && existsSync(join(PACKAGED_RUNTIME, 'bun.exe'))
  && existsSync(join(PACKAGED_RUNTIME, 'pmbrain-sidecar.js'));
const packagedTest = WINDOWS_RUNTIME_READY ? test : test.skip;

function simplePdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(escaped) + 44} >>\nstream\nBT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('CLI import child process lifecycle', () => {
  let workspace = '';
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pmbrain-cli-import-exit-'));
    const configDir = join(workspace, '.pmbrain');
    const databasePath = join(workspace, 'brain.pglite');
    const knowledgeDirectory = join(workspace, 'knowledge-source');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(knowledgeDirectory, { recursive: true });

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname.endsWith('/models')) {
          return Response.json({ object: 'list', data: [{ id: 'e2e-embedding-8', object: 'model' }] });
        }
        if (request.method === 'POST' && url.pathname.endsWith('/embeddings')) {
          const body = await request.json() as { input?: string | string[] };
          const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
          return Response.json({
            object: 'list',
            data: input.map((_value, index) => ({
              object: 'embedding',
              index,
              embedding: new Array<number>(8).fill(0.125),
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: databasePath,
      embedding_model: 'custom-openai:e2e-embedding-8',
      embedding_dimensions: 8,
      provider_base_urls: { 'custom-openai': `http://127.0.0.1:${server.port}/v1` },
      provider_touchpoint_base_urls: {
        'custom-openai': { embedding: `http://127.0.0.1:${server.port}/v1` },
      },
      desktop: {
        knowledge_directory: knowledgeDirectory,
        knowledge_source_id: 'desktop-e2e',
      },
    }, null, 2) + '\n');

    configureGateway({
      embedding_model: 'custom-openai:e2e-embedding-8',
      embedding_dimensions: 8,
      base_urls: { 'custom-openai': `http://127.0.0.1:${server.port}/v1` },
      env: {},
    });
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: databasePath });
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      ['desktop-e2e', 'Desktop E2E', knowledgeDirectory],
    );
    await engine.setConfig('sources.default', 'desktop-e2e');
    await engine.disconnect();
    resetGateway();
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    if (!workspace) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(workspace, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EFAULT', 'EBUSY', 'EPERM'].includes(code ?? '')) throw error;
        if (attempt < 2) await Bun.sleep(100);
      }
    }
  });

  test('the Sidecar releases PGLite, the Markdown child exits, and the Sidecar reconnects', async () => {
    const markdown = join(workspace, 'real-user-journey.md');
    writeFileSync(markdown, [
      '---',
      'title: Real User Journey Orchid',
      'tags: [e2e]',
      '---',
      '',
      '# Real User Journey Orchid',
      '',
      'The searchable marker is pmbrain-real-e2e-orchid-7429.',
      '',
    ].join('\n'));

    const previousEnv = {
      PMBRAIN_HOME: process.env.PMBRAIN_HOME,
      GBRAIN_HOME: process.env.GBRAIN_HOME,
      DATABASE_URL: process.env.DATABASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.PMBRAIN_HOME = workspace;
    process.env.GBRAIN_HOME = '';
    process.env.DATABASE_URL = '';
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';

    const databasePath = join(workspace, 'brain.pglite');
    const engine = new PGLiteEngine();
    const coordinator = new PgliteRunCoordinator();
    try {
      await engine.connect({ engine: 'pglite', database_path: databasePath });
      const accepted = await startImportRun(engine, {
        path: markdown,
        sourceId: 'default',
        fresh: true,
        reportFiles: true,
      }, REPO, {
        acquireExclusive: () => coordinator.acquire(),
        beforeSpawn: () => engine.disconnect(),
        afterComplete: () => engine.connect({ engine: 'pglite', database_path: databasePath }),
      });

      const deadline = Date.now() + 30_000;
      let completed = getRun(accepted.id);
      while (completed && (completed.status === 'queued' || completed.status === 'running') && Date.now() < deadline) {
        await Bun.sleep(100);
        completed = getRun(accepted.id);
      }

      expect(completed?.status, `stdout:\n${completed?.stdout ?? ''}\n\nstderr:\n${completed?.stderr ?? ''}`).toBe('completed');
      expect(completed?.stderr).toContain('[pmbrain import-file]');
      expect(completed?.stdout).toContain('1 pages imported');
      expect((await engine.getPage('real-user-journey'))?.title).toBe('Real User Journey Orchid');
    } finally {
      await engine.disconnect().catch(() => undefined);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  packagedTest('the assembled Windows Sidecar runtime also exits after Markdown import', async () => {
    const markdown = join(workspace, 'packaged-runtime.md');
    writeFileSync(markdown, '# Packaged runtime\n\nThe packaged Sidecar must exit after importing this page.\n');
    const proc = Bun.spawn([
      join(PACKAGED_RUNTIME, 'bun.exe'),
      join(PACKAGED_RUNTIME, 'pmbrain-sidecar.js'),
      'import',
      markdown,
      '--fresh',
      '--report-files',
      '--source-id',
      'default',
    ], {
      cwd: PACKAGED_RUNTIME,
      env: {
        ...process.env,
        PMBRAIN_HOME: workspace,
        GBRAIN_HOME: '',
        DATABASE_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const outcome = await Promise.race([
      proc.exited.then(exitCode => ({ kind: 'exited' as const, exitCode })),
      Bun.sleep(30_000).then(() => ({ kind: 'timeout' as const, exitCode: null })),
    ]);
    if (outcome.kind === 'timeout') proc.kill('SIGKILL');
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    expect(outcome, `stdout:\n${stdout}\n\nstderr:\n${stderr}`).toEqual({ kind: 'exited', exitCode: 0 });
    expect(stderr).toContain('[pmbrain import-file]');
    expect(stdout).toContain('1 pages imported');
  }, 60_000);

  packagedTest('the assembled Sidecar completes sequential authenticated Markdown and PDF uploads', async () => {
    const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
    const port = portProbe.port;
    portProbe.stop(true);
    const bootstrapToken = 'pmbrain-test-bootstrap-token-1234567890';
    const proc = Bun.spawn([
      join(PACKAGED_RUNTIME, 'bun.exe'),
      join(PACKAGED_RUNTIME, 'pmbrain-sidecar.js'),
      'serve',
      '--http',
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--suppress-bootstrap-token',
    ], {
      cwd: PACKAGED_RUNTIME,
      env: {
        ...process.env,
        PMBRAIN_HOME: workspace,
        PMBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,
        GBRAIN_HOME: '',
        DATABASE_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    try {
      const origin = `http://127.0.0.1:${port}`;
      const readyDeadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < readyDeadline) {
        try {
          const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
          if (health.ok) {
            ready = true;
            break;
          }
        } catch { /* not ready */ }
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);

      const login = await fetch(`${origin}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
      expect(cookie).toStartWith('pmbrain_admin=');

      type AdminRun = { status?: string; stdout?: string; stderr?: string; error?: string };
      const uploadAndWait = async (fileName: string, body: string | Buffer): Promise<AdminRun | null> => {
        const upload = await fetch(
          `${origin}/admin/api/import-upload-runs?autoEmbed=true&structuredDocuments=true&documentOcr=false&workers=1`,
          {
            method: 'POST',
            headers: {
              cookie,
              'content-type': 'application/octet-stream',
              'x-pmbrain-filename': fileName,
            },
            body: typeof body === 'string' ? body : Uint8Array.from(body).buffer,
          },
        );
        const accepted = await upload.json() as { runId?: string; error?: string };
        expect(upload.status, JSON.stringify(accepted)).toBe(202);
        expect(accepted.runId).toBeString();

        const runDeadline = Date.now() + 30_000;
        let run: AdminRun | null = null;
        while (Date.now() < runDeadline) {
          const response = await fetch(`${origin}/admin/api/runs/${accepted.runId}`, { headers: { cookie } });
          run = await response.json() as AdminRun;
          if (run?.status && !['queued', 'running'].includes(run.status)) break;
          await Bun.sleep(100);
        }
        expect(run?.status, `${fileName}\nstdout:\n${run?.stdout ?? ''}\n\nstderr:\n${run?.stderr ?? ''}\n\nerror:\n${run?.error ?? ''}`).toBe('completed');
        const receipt = (run?.stdout ?? '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(item => item.status === 'success');
        expect(receipt).toMatchObject({ imported: 1, errors: 0, total_files: 1 });
        return run;
      };

      await uploadAndWait('packaged-admin-upload.md', '# Packaged Admin upload\n\nThe authenticated upload must complete.\n');
      await uploadAndWait('packaged-admin-upload.pdf', simplePdf('The structured PDF upload must complete.'));
    } finally {
      try { proc.kill('SIGTERM'); } catch { /* already stopped */ }
      await Promise.race([proc.exited, Bun.sleep(5_000)]);
      if (proc.exitCode === null && proc.pid) {
        const killer = Bun.spawn(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
        await killer.exited;
      }
      await Promise.allSettled([stdoutPromise, stderrPromise]);
    }
  }, 90_000);
});
