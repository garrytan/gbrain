/**
 * A loopback npm registry serving one tiny package, for installer scripts under test.
 *
 * The packument request can be made to fail first: `race: { kind: 'ETARGET' | 'E404', times }`
 * answers the first `times` packument requests the way a registry does while a release is
 * still propagating (a packument without the requested version, or no packument at all), then
 * serves the real one. `platform: 'unsupported'` publishes the version for an operating system
 * that does not exist (`EBADPLATFORM`), a failure no retry should wait out.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUB_PACKAGE = 'gbrain-openclaw-probe';
export const STUB_VERSION = '1.0.0';

export interface StubRegistryOptions { dir: string; race?: { kind: 'ETARGET' | 'E404'; times: number }; platform?: 'unsupported' }

export async function startStubRegistry(options: StubRegistryOptions) {
  const pkgDir = join(options.dir, 'pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: STUB_PACKAGE, version: STUB_VERSION, bin: { [STUB_PACKAGE]: 'bin.js' } }));
  writeFileSync(join(pkgDir, 'bin.js'), '#!/usr/bin/env node\nconsole.log("probe");\n');
  const packed = Bun.spawnSync(['npm', 'pack', '--silent', '--pack-destination', options.dir], { cwd: pkgDir,
    env: { ...process.env, npm_config_cache: join(options.dir, 'pack-cache'), npm_config_update_notifier: 'false' } });
  if (packed.exitCode) throw new Error(`npm pack: ${packed.stderr.toString()}`);
  const tarball = readFileSync(join(options.dir, packed.stdout.toString().trim()));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  let packumentRequests = 0, tarballRequests = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path === `/${STUB_PACKAGE}`) {
        packumentRequests++;
        const racing = options.race && packumentRequests <= options.race.times;
        if (racing && options.race!.kind === 'E404') return Response.json({ error: 'Not found' }, { status: 404 });
        const version = racing ? '0.9.0' : STUB_VERSION;
        return Response.json({ name: STUB_PACKAGE, 'dist-tags': { latest: version }, versions: { [version]: {
          name: STUB_PACKAGE, version, bin: { [STUB_PACKAGE]: 'bin.js' }, ...(options.platform ? { os: ['gbrain-nowhere'] } : {}),
          dist: { tarball: `http://127.0.0.1:${server.port}/${STUB_PACKAGE}/-/${STUB_PACKAGE}-${version}.tgz`, integrity } } } });
      }
      if (path.endsWith('.tgz')) { tarballRequests++; return new Response(tarball, { headers: { 'content-type': 'application/octet-stream' } }); }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    requests: () => ({ packument: packumentRequests, tarball: tarballRequests }),
    stop: () => server.stop(true),
  };
}

/** Environment that points npm's global install at the stub registry and a throwaway prefix. */
export function stubNpmEnv(registryUrl: string, dir: string): Record<string, string> {
  return { npm_config_registry: registryUrl, npm_config_prefix: join(dir, 'prefix'), npm_config_cache: join(dir, 'cache'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_loglevel: 'error' };
}
