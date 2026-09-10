import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';
import type { GBrainOAuthProvider } from '../core/oauth-provider.ts';

type Consent = { session: string; query: string; redirect: string; state?: string; expires: number; approved: boolean };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to GBrain</title></head><body><main>${body}</main></body></html>`;

/** Mount BEFORE the SDK auth router. Nonces bind consent to this admin session
 * and the complete authorization request; approving a different request cannot
 * authorize this one. The SDK still validates PKCE, redirects and client grants. */
export function mountOAuthOwnerConsent(app: Express, options: {
  provider: GBrainOAuthProvider;
  sessionValid: (session: string) => boolean;
  publicOrigin: string;
}) {
  const pending = new Map<string, Consent>();
  const session = (req: Request) => typeof req.cookies?.gbrain_admin === 'string' ? req.cookies.gbrain_admin as string : '';
  const fail = (res: Response, status: number, error: string) => res.status(status).json({ error, error_description: 'Open the connection again and approve it from an authenticated GBrain admin session.' });
  const prune = () => { for (const [id, item] of pending) if (item.expires < Date.now()) pending.delete(id); };

  app.post('/authorize/consent', express.urlencoded({ extended: false }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const nonce = typeof req.body?.nonce === 'string' ? req.body.nonce : '';
    const item = pending.get(nonce);
    const sid = session(req);
    if (!item || item.expires < Date.now() || item.session !== sid || !options.sessionValid(sid) || item.approved) return void fail(res, 403, 'consent_expired');
    if (req.headers.origin && req.headers.origin !== options.publicOrigin) return void fail(res, 403, 'invalid_origin');
    if (req.body?.decision !== 'approve') {
      pending.delete(nonce);
      const target = new URL(item.redirect);
      target.searchParams.set('error', 'access_denied');
      if (item.state) target.searchParams.set('state', item.state);
      res.redirect(303, target.toString());
      return;
    }
    item.approved = true;
    const target = new URLSearchParams(item.query);
    target.set('_gbrain_approval', nonce);
    res.redirect(303, `/authorize?${target}`);
  });

  app.use('/authorize', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    // Only the canonical endpoint is gated here; our consent POST terminated above.
    if (req.path !== '/' && req.path !== '') { next(); return; }
    if (req.method !== 'GET') { fail(res, 405, 'authorization_requires_browser'); return; }
    const sid = session(req);
    if (!options.sessionValid(sid)) {
      res.status(401).type('html').send(page(`<h1>Sign in to approve this connection</h1><p>Use the admin token from your GBrain server. It is sent only to this server.</p><form id="login"><label>Admin token <input name="token" type="password" required autocomplete="off"></label><button>Sign in</button></form><p id="result" role="status"></p><script>document.getElementById('login').onsubmit=async function(event){event.preventDefault();const response=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:new FormData(this).get('token')})});if(response.ok)location.reload();else document.getElementById('result').textContent='Sign in failed. Check the admin token.';};</script>`));
      return;
    }
    try {
      const params = new URL(req.originalUrl, options.publicOrigin).searchParams;
      const approved = params.get('_gbrain_approval');
      params.delete('_gbrain_approval');
      if (approved) {
        const item = pending.get(approved);
        pending.delete(approved);
        if (!item || !item.approved || item.expires < Date.now() || item.session !== sid || item.query !== params.toString()) { fail(res, 403, 'consent_expired'); return; }
        // Strip our transport-only field before the SDK validates the request.
        req.url = `/?${params}`;
        res.locals.gbrainOwnerApproved = true;
        next();
        return;
      }
      const clientId = params.get('client_id');
      if (!clientId) { fail(res, 400, 'invalid_client'); return; }
      const client = await options.provider.clientsStore.getClient(clientId);
      const redirect = params.get('redirect_uri');
      if (!client || !redirect || !client.redirect_uris.includes(redirect)) { fail(res, 400, 'invalid_redirect_uri'); return; }
      prune();
      if (pending.size >= 1000) { fail(res, 429, 'consent_busy'); return; }
      const nonce = randomBytes(32).toString('hex');
      pending.set(nonce, { session: sid, query: params.toString(), redirect, state: params.get('state') ?? undefined, expires: Date.now() + 300_000, approved: false });
      const requested = params.get('scope') || client.scope || '(client defaults)';
      res.type('html').send(page(`<h1>Connect ${escape(client.client_name || 'this client')} to GBrain</h1><p>Client: <code>${escape(clientId)}</code></p><p>Requested permissions: <strong>${escape(requested)}</strong>. The registered grant remains the ceiling.</p><p>Return address: ${escape(redirect)}</p><form method="post" action="/authorize/consent"><input type="hidden" name="nonce" value="${nonce}"><button name="decision" value="approve">Approve connection</button> <button name="decision" value="deny">Cancel</button></form>`));
    } catch { fail(res, 400, 'invalid_authorization_request'); }
  });
}
