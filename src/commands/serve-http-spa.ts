/**
 * Admin SPA serving for `gbrain serve --http` (v0.36.x #1090): the dev
 * admin/dist directory when present next to cwd, otherwise the embedded
 * asset manifest compiled into the binary.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { ServeHttpContext } from './serve-http.ts';

export async function mountSpa(app: Express, ctx: ServeHttpContext): Promise<void> {
  const { oauthProvider } = ctx;
  // ---------------------------------------------------------------------------
  // Admin SPA static files (v0.36.x #1090)
  // ---------------------------------------------------------------------------
  // Two-tier resolution:
  //   1. Dev path — admin/dist next to cwd. Vite rebuilds land here first,
  //      so devs hacking on the SPA see changes without re-running
  //      build-admin-embedded.
  //   2. Binary path — `src/admin-embedded.ts` exports `ADMIN_ASSETS`, a
  //      manifest of request-path → resolved-path keyed by every file in
  //      admin/dist at generation time. Bun's `with { type: 'file' }` ESM
  //      imports resolve correctly inside the compiled binary, so a
  //      globally-installed `gbrain serve --http` actually serves /admin
  //      instead of 404. Pre-fix the cwd-relative path was the ONLY
  //      resolution path, and every fresh install of the compiled binary
  //      hit 404 on /admin (issue #1090).
  const path = await import('path');
  const fs = await import('fs');
  const adminDistPath = path.join(process.cwd(), 'admin', 'dist');
  const useDevPath = fs.existsSync(adminDistPath);
  if (useDevPath) {
    app.use('/admin', express.static(adminDistPath));
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      res.sendFile('index.html', { root: adminDistPath }); // Exclude hidden checkout ancestors from dotfile checks.
    });
  } else {
    // Embedded path. Read assets from the generated manifest. Cache the
    // bytes per asset on first request — these never change for a given
    // binary, so subsequent requests skip the fs read.
    const { ADMIN_ASSETS, ADMIN_INDEX_HTML } = await import('../admin-embedded.ts');
    const cache = new Map<string, Buffer>();
    function loadAsset(asset: { path: string }): Buffer {
      const hit = cache.get(asset.path);
      if (hit) return hit;
      const buf = fs.readFileSync(asset.path);
      cache.set(asset.path, buf);
      return buf;
    }
    // Bare /admin (no trailing slash) never matches the '/admin/{*path}'
    // pattern below — path-to-regexp requires the literal '/' that
    // precedes the wildcard segment. The dev-path branch above doesn't need
    // this: express.static() issues its own redirect-to-trailing-slash for
    // a directory index request. Mirror that behavior explicitly here.
    // Express route matching is non-strict by default, so the '/admin'
    // pattern below also matches '/admin/' — guard on the exact path so
    // it doesn't shadow the '/admin/{*path}' handler and redirect-loop.
    app.get('/admin', (req: Request, res: Response, next: NextFunction) => {
      if (req.path !== '/admin') {
        return next();
      }
      const pendingId = req.query.oauth_request;
    if (pendingId !== undefined && !oauthProvider.grants.hasPending(pendingId)) {
      res.status(410).send('This OAuth request expired, completed, or the server restarted. Restart authorization in the native client and ask the server administrator for a new login link with the new pending-request ID.');
      return;
    }
    res.redirect(oauthProvider.grants.hasPending(pendingId)
      ? `/admin/?oauth_request=${pendingId}#oauth-consent` : '/admin/');
    });
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      const hit = ADMIN_ASSETS[req.path];
      if (hit) {
        res.setHeader('Content-Type', hit.mime);
        res.send(loadAsset(hit));
        return;
      }
      // SPA fallback — every unmatched /admin/* route resolves to index.html
      // so client-side routing takes over (login, dashboard, agents, ...).
      if (ADMIN_INDEX_HTML) {
        res.setHeader('Content-Type', ADMIN_INDEX_HTML.mime);
        res.send(loadAsset(ADMIN_INDEX_HTML));
        return;
      }
      res.status(404).send('admin SPA not available');
    });
  }
}
