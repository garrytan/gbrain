/**
 * Ruby call edges resolve, on every backend (PGLite always; Postgres when a
 * safe DATABASE_URL is set, and in the E2E lane through
 * test/e2e/code-intel-ruby-postgres.test.ts).
 *
 * Ruby chunks are qualified `A::B#m` / `A::B.m`. Before the extractor named
 * Ruby receivers, every Ruby call edge carried a bare token (`attempt`, `new`,
 * `run`) that never equals a qualified chunk name, so a Rails app resolved 0
 * edges, `code_callers` on a class found nothing, and `code_blast` /
 * `code_flow` refused Ruby as unsupported_language.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../../src/core/chunkers/symbol-resolver.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const HEALTH_CHECK = `module Acme
  class HealthCheck
    def self.run(client:)
      new(client: client).run
    end

    def initialize(client:)
      @client = client
    end

    def run
      attempt { @client.ping }
      record(:ok)
    end

    private

    def attempt
      yield
    end

    def record(status)
      status
    end
  end
end
`;

const PROBE_JOB = `module Acme
  class HealthProbeJob
    def perform(client)
      Acme::HealthCheck.new(client: client).run
    end
  end
end
`;

for (const kind of testBackends()) {
  describe(`Ruby call-edge resolution (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => {
      await close?.();
    });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'app-%' OR slug LIKE 'lib-%'`);
      await importCodeFile(engine, 'app/services/acme/health_check.rb', HEALTH_CHECK, { noEmbed: true });
      await importCodeFile(engine, 'app/jobs/acme/health_probe_job.rb', PROBE_JOB, { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    });

    const resolvedCallers = async (symbol: string) =>
      (await engine.getCallersOf(symbol, { sourceId: 'default' })).map((e) => `${e.from_symbol_qualified}${e.resolved ? '' : ' (by name)'}`).sort();

    test('same-file calls resolve to their Ruby chunks', async () => {
      expect(await resolvedCallers('Acme::HealthCheck#attempt')).toEqual(['Acme::HealthCheck#run']);
      expect(await resolvedCallers('Acme::HealthCheck#record')).toEqual(['Acme::HealthCheck#run']);
      // `def self.run` and `def run` are different chunks; `new(...).run` calls the instance one.
      expect(await resolvedCallers('Acme::HealthCheck#run')).toEqual(['Acme::HealthCheck.run', 'Acme::HealthProbeJob#perform (by name)']);
    });

    test('code_callers on a class finds the files that construct it', async () => {
      const op: any = await handleToolCall(engine, 'code_callers', { symbol: 'Acme::HealthCheck' });
      const callers = op.callers.map((e: any) => `${e.from_symbol_qualified}${e.resolved ? '' : ' (by name)'}`).sort();
      expect(callers).toEqual(['Acme::HealthCheck.run', 'Acme::HealthProbeJob#perform (by name)']);
    });

    test('code_blast walks Ruby callers instead of refusing the language', async () => {
      const op: any = await handleToolCall(engine, 'code_blast', { symbol: 'Acme::HealthCheck#attempt' });
      expect(op.result).toBe('ok');
      expect(op.depth_groups.map((g: any) => g.nodes.map((n: any) => n.symbol))).toEqual([
        ['Acme::HealthCheck#run'],
        ['Acme::HealthCheck.run'],
      ]);
    });

    test('code_flow follows a Ruby entry point through resolved hops', async () => {
      const op: any = await handleToolCall(engine, 'code_flow', { entry_point: 'Acme::HealthCheck.run' });
      expect(op.result).toBe('ok');
      const byDepth = op.depth_groups.map((g: any) => g.nodes.map((n: any) => n.symbol).sort());
      expect(byDepth[0]).toEqual(['Acme::HealthCheck', 'Acme::HealthCheck#run']);
      // `@client.ping` has an untyped receiver and stays a bare name.
      expect(byDepth[1]).toEqual(['Acme::HealthCheck#attempt', 'Acme::HealthCheck#record', 'ping']);
    });

    test('two same-file definitions of one method stay ambiguous, not guessed', async () => {
      await importCodeFile(engine, 'app/models/acme/report.rb', `module Acme
  class Report
    def build
      render_row(1)
    end

    def render_row(x); end
  end

  class Report
    def render_row(x); end
  end
end
`, { noEmbed: true });
      const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(stats.edges_ambiguous).toBe(1);
      const [edge] = await engine.getCallersOf('Acme::Report#render_row', { sourceId: 'default' });
      expect(edge?.resolved).toBe(false);
      expect(edge?.edge_metadata.ambiguous).toBe(true);
      expect(edge?.edge_metadata.candidates).toHaveLength(2);
    });

    test('a paren-less call resolves to its chunk; a local of the same name does not', async () => {
      await importCodeFile(engine, 'app/models/acme/report.rb', `module Acme
  class Report
    def build
      title = 1
      attempt { header }
      title
    end

    def attempt = yield
    def header; end
    def title; end
  end
end
`, { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(await resolvedCallers('Acme::Report#header')).toEqual(['Acme::Report#build']);
      expect(await resolvedCallers('Acme::Report#title')).toEqual([]);
    });

    test('a setter call resolves to the setter, never the getter', async () => {
      await importCodeFile(engine, 'app/models/thermostat.rb',
        'class Thermostat\n  def bump\n    self.target = 72\n  end\n\n  def target\n    @target\n  end\n\n  def target=(v)\n    @target = v\n  end\nend\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(await resolvedCallers('Thermostat#target')).toEqual([]);
      expect(await resolvedCallers('Thermostat#target=')).toEqual(['Thermostat#bump']);
    });

    test('a def inside a block in a module is not a caller of the module', async () => {
      await importCodeFile(engine, 'app/services/billing/ledger_reading.rb',
        'module Billing\n  LedgerReading = Data.define(:amount) do\n    def self.from_record(record)\n      new(amount: record.amount)\n    end\n  end\nend\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(await resolvedCallers('Billing')).toEqual([]);
    });

    test('code_flow tags Ruby sinks', async () => {
      await importCodeFile(engine, 'app/services/acme/fetcher.rb',
        'module Acme\n  class Fetcher\n    def run(uri)\n      Net::HTTP.get(uri)\n      system("true")\n      File.write("x", "y")\n    end\n  end\nend\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      const op: any = await handleToolCall(engine, 'code_flow', { entry_point: 'Acme::Fetcher#run' });
      expect(op.terminal_nodes.map((t: any) => `${t.symbol} ${t.sink_kind}`).sort())
        .toEqual(['File.write file_io', 'Net::HTTP.get http_call', 'system process_exec']);
    });

    describe('relative constants defined in another file', () => {
      const CALLER = `module Acme
  class Dashboard
    def show
      Client.new.ping
      Ledger.post(1)
      Widget.build(1)
    end
  end
end
`;
      const importLib = (path: string, src: string, opts: { sourceId?: string; force?: boolean } = {}) =>
        importCodeFile(engine, path, src, { noEmbed: true, ...opts });
      const callees = async () =>
        (await engine.getCalleesOf('Acme::Dashboard#show', { sourceId: 'default' })).map((e) => e.to_symbol_qualified).sort();

      test('take the nested name Ruby looks up first, from the other files of the source', async () => {
        await importLib('lib/acme/client.rb', 'module Acme\n  class Client\n    def ping; end\n  end\nend\n');
        await importLib('lib/acme/ledger.rb', 'class Acme::Ledger\n  def self.post(x); end\nend\n');
        // Only a top-level Widget exists: Ruby would go on to ancestors and the top level, so the name stays.
        await importLib('lib/widget.rb', 'class Widget\n  def self.build(x); end\nend\n');
        await importLib('app/models/acme/dashboard.rb', CALLER);
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect(await callees()).toEqual(['Acme::Client', 'Acme::Client#ping', 'Acme::Ledger.post', 'Widget.build']);
        const op: any = await handleToolCall(engine, 'code_callers', { symbol: 'Acme::Client#ping' });
        expect(op.callers.map((e: any) => e.from_symbol_qualified)).toEqual(['Acme::Dashboard#show']);
        // A renamed edge keeps its hand-off, so a later change of definitions can move it again.
        expect(op.callers[0].edge_metadata).toMatchObject({ ruby_nesting: ['Acme::Dashboard', 'Acme'], ruby_default: 'Client#ping' });
      });

      test('the innermost scope wins when several define the constant (Ruby lookup order)', async () => {
        await importLib('lib/acme/client.rb', 'module Acme\n  class Client\n    def ping; end\n  end\nend\n');
        await importLib('lib/acme/dashboard/client.rb', 'class Acme::Dashboard::Client\n  def ping; end\nend\n');
        await importLib('app/models/acme/dashboard.rb', CALLER);
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect((await callees()).filter((n) => n.includes('Client'))).toEqual(['Acme::Dashboard::Client', 'Acme::Dashboard::Client#ping']);
      });

      test('never from a private page or another source', async () => {
        await importLib('lib/acme/client.rb', 'module Acme\n  class Client\n    def ping; end\n  end\nend\n');
        await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE slug LIKE 'lib%client%'`);
        // Keep the projection current so the private flag, not a stale projection, is what hides the page.
        await engine.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug LIKE 'lib%client%'`);
        await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config, created_at) VALUES ('ruby-other', 'ruby-other', '/fake/ruby-other', '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`);
        await importLib('lib/acme/ledger.rb', 'class Acme::Ledger\n  def self.post(x); end\nend\n', { sourceId: 'ruby-other' });
        await importLib('app/models/acme/dashboard.rb', CALLER);
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect(await callees()).toEqual(['Client', 'Client#ping', 'Ledger.post', 'Widget.build']);
      });

      test('never from unsealed chunks (chunked before the safe fence)', async () => {
        await importLib('lib/acme/client.rb', 'module Acme\n  class Client\n    def ping; end\n  end\nend\n');
        await engine.executeRaw(`UPDATE pages SET chunker_version = 0 WHERE slug LIKE 'lib%client%'`);
        await importLib('app/models/acme/dashboard.rb', CALLER);
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect((await callees()).filter((n) => n.includes('Client'))).toEqual(['Client', 'Client#ping']);
      });

      test('a scope the caller\'s file proves yields to an inner scope defined in another file', async () => {
        const OWN = 'module Acme\n  class Client; end\n  class Widget\n    def run\n      Client.fetch(1)\n    end\n  end\nend\n';
        await importLib('app/models/acme/widget.rb', OWN);
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        const widgetCallees = async () => (await engine.getCalleesOf('Acme::Widget#run', { sourceId: 'default' })).map((e) => e.to_symbol_qualified);
        expect(await widgetCallees()).toEqual(['Acme::Client.fetch']);
        await importLib('lib/acme/widget/client.rb', 'class Acme::Widget::Client\n  def self.fetch(x); end\nend\n');
        await importLib('app/models/acme/widget.rb', OWN, { force: true });
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect(await widgetCallees()).toEqual(['Acme::Widget::Client.fetch']);
      });

      describe('a change of definitions after the caller resolved re-qualifies it', () => {
        const CLIENT = 'module Acme\n  class Client\n    def ping; end\n  end\nend\n';
        const clientCallees = async () => (await callees()).filter((n) => n.includes('Client'));
        const resolveAll = () => resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });

        test('the definer turns private: the edge goes back to the written name', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          expect(await clientCallees()).toEqual(['Acme::Client', 'Acme::Client#ping']);
          await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE slug LIKE 'lib%client%'`);
          await engine.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug LIKE 'lib%client%'`);
          await resolveAll();
          expect(await clientCallees()).toEqual(['Client', 'Client#ping']);
        });

        test('the definer is deleted: the edge goes back to the written name', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          await engine.softDeletePage('lib-acme-client-rb', { sourceId: 'default' });
          await resolveAll();
          expect(await clientCallees()).toEqual(['Client', 'Client#ping']);
        });

        test('an inner namesake added later wins', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          await importLib('lib/acme/dashboard/client.rb', 'class Acme::Dashboard::Client\n  def ping; end\nend\n');
          await resolveAll();
          expect(await clientCallees()).toEqual(['Acme::Dashboard::Client', 'Acme::Dashboard::Client#ping']);
        });

        test('a renamed edge drops the within-file resolution stamped under its old name', async () => {
          // The caller's file defines a top-level Client, so `Client.fetch` first resolves within the file.
          await importLib('app/models/acme/report.rb',
            'class Client\n  def self.fetch(x); end\nend\n\nmodule Acme\n  class Report\n    def show\n      Client.fetch(1)\n    end\n  end\nend\n');
          await resolveAll();
          const edge = async () => (await engine.getCalleesOf('Acme::Report#show', { sourceId: 'default' }))[0]!;
          expect((await edge()).resolved).toBe(true);
          await importLib('lib/acme/client.rb', 'class Acme::Client\n  def self.fetch(x); end\nend\n');
          await resolveAll();
          expect((await edge()).to_symbol_qualified).toBe('Acme::Client.fetch');
          expect((await edge()).resolved).toBe(false);
        });

        test('an unchanged source re-walks nothing', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          expect((await resolveAll()).chunks_walked).toBe(0);
        });

        test('a definition change in another source re-walks nothing here', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config, created_at) VALUES ('ruby-other', 'ruby-other', '/fake/ruby-other', '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`);
          await importLib('lib/acme/ledger.rb', 'class Acme::Ledger\n  def self.post(x); end\nend\n', { sourceId: 'ruby-other' });
          expect((await resolveAll()).chunks_walked).toBe(0);
        });

        test('overlapping runs: a batch that read the definer before it turned private does not keep the stale name', async () => {
          await importLib('lib/acme/client.rb', CLIENT);
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          await importLib('app/models/acme/dashboard.rb', CALLER, { force: true });
          // Run A walks the caller against the public definer. Before A stamps the watermark, the
          // definer turns private and run B's refresh resets the caller and records the new fingerprint.
          let fired = false;
          const raceInto = (tx: BrainEngine): BrainEngine => new Proxy(tx, {
            get(target, key) {
              if (key === 'executeRaw') {
                return async (sql: string, params?: unknown[]) => {
                  if (!fired && /SET edges_backfilled_at = NOW\(\)/.test(sql)) {
                    fired = true;
                    await target.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE slug LIKE 'lib%client%'`);
                    await target.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug LIKE 'lib%client%'`);
                    await resolveSymbolEdgesIncremental(target, { sourceId: 'default', maxChunks: 0 });
                  }
                  return target.executeRaw(sql, params as never);
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const runA = new Proxy(engine, {
            get(target, key) {
              if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction((tx) => fn(raceInto(tx)));
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          await resolveSymbolEdgesIncremental(runA, { sourceId: 'default' });
          expect(fired).toBe(true);
          expect(await clientCallees()).toEqual(['Acme::Client', 'Acme::Client#ping']);
          await resolveAll();
          expect(await clientCallees()).toEqual(['Client', 'Client#ping']);
        });

        test('a definer added after the caller resolved qualifies it', async () => {
          await importLib('app/models/acme/dashboard.rb', CALLER);
          await resolveAll();
          expect(await clientCallees()).toEqual(['Client', 'Client#ping']);
          await importLib('lib/acme/client.rb', CLIENT);
          await resolveAll();
          expect(await clientCallees()).toEqual(['Acme::Client', 'Acme::Client#ping']);
        });
      });

      test('a caller that also spells the constant in full keeps one edge', async () => {
        await importLib('lib/acme/client.rb', 'module Acme\n  class Client\n    def self.fetch(x); end\n  end\nend\n');
        await importLib('app/models/acme/both.rb', 'module Acme\n  class Both\n    def run\n      Client.fetch(1)\n      Acme::Client.fetch(2)\n    end\n  end\nend\n');
        await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
        expect((await engine.getCalleesOf('Acme::Both#run', { sourceId: 'default' })).map((e) => e.to_symbol_qualified)).toEqual(['Acme::Client.fetch']);
      });
    });
  });
}
