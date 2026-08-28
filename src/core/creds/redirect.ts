/**
 * creds/redirect — how the OAuth authorization code gets back to us.
 *
 * Three strategies behind one seam (the hosted product reuses the same
 * provider code with its own callback):
 *  - 'loopback'        ephemeral 127.0.0.1 listener (Bun.serve), the Google-
 *                      blessed desktop flow. Browser opens best-effort.
 *  - 'paste'           no listener. The auth URL redirects to a fixed
 *                      127.0.0.1 port nobody is listening on; the user pastes
 *                      the full failed-to-load URL back (Google puts the code
 *                      in the redirect regardless). This is the headless/SSH/
 *                      agent-on-another-machine path, auto-selected by sniff.
 *  - 'hosted-callback' gbrain.io's registered redirect (relay / hosted web).
 *
 * Note: Google's device-code flow is NOT an option here — Gmail/Calendar/
 * Contacts scopes are not on its allowed-scope list. Don't re-litigate.
 */

import { CredentialError } from './errors.ts';

export type RedirectStrategy = 'loopback' | 'paste' | 'hosted-callback';

/** The fixed redirect used in paste mode (no listener required). */
export const PASTE_REDIRECT_URI = 'http://127.0.0.1:41999/';

// ── Environment sniff ────────────────────────────────────────────────────────

export interface SniffInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
}

/**
 * True when a local browser almost certainly can't open here: SSH session,
 * Linux with no display server, WSL, or a container. Paste mode is then the
 * default (not an error — the flow just changes shape).
 */
export function sniffHeadless(input: SniffInput = {}): boolean {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if (env.GBRAIN_FORCE_PASTE === '1') return true;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

// ── Paste-back parsing ───────────────────────────────────────────────────────

export interface ParsedRedirect {
  code: string;
  state: string | null;
}

/**
 * Parse whatever the user pasted after approving consent: the full
 * http://127.0.0.1:…/?code=…&state=… URL (the "site can't be reached" page's
 * address bar), a partial querystring, or a bare authorization code.
 * The #1 mistake — pasting the consent page URL instead — gets its own error.
 */
export function parsePastedRedirect(pasted: string, expectedState?: string): ParsedRedirect {
  const raw = pasted.trim().replace(/\s+/g, '');
  if (raw.length === 0) throw new CredentialError('pasted_wrong_url');
  if (/accounts\.google\.com/i.test(raw)) throw new CredentialError('pasted_wrong_url');

  let code: string | null = null;
  let state: string | null = null;
  const tryParams = (qs: string): void => {
    const params = new URLSearchParams(qs);
    if (params.get('error') === 'access_denied') {
      throw new CredentialError('access_denied_test_user');
    }
    code = params.get('code');
    state = params.get('state');
  };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      tryParams(url.search.replace(/^\?/, ''));
    } catch (e) {
      if (e instanceof CredentialError) throw e;
      throw new CredentialError('pasted_wrong_url');
    }
  } else if (raw.includes('code=')) {
    tryParams(raw.replace(/^\?/, ''));
  } else {
    // Bare code paste. Google codes start with "4/".
    code = decodeURIComponent(raw);
  }

  if (!code) throw new CredentialError('pasted_wrong_url');
  if (expectedState) {
    // A full redirect URL / querystring paste MUST carry the matching state
    // (CSRF binding). Only a bare-code paste legitimately has no state —
    // there, PKCE's code-verifier binding is the remaining defense.
    const pastedUrlOrQuery = /^https?:\/\//i.test(raw) || raw.includes('code=');
    if (pastedUrlOrQuery && state !== expectedState) {
      throw new CredentialError('state_mismatch');
    }
  }
  return { code: decodeURIComponent(code), state };
}

// ── Loopback listener ────────────────────────────────────────────────────────

export interface LoopbackHandle {
  redirectUri: string;
  port: number;
  /** Resolves with the authorization code, or rejects with a CredentialError. */
  codePromise: Promise<string>;
  close(): void;
}

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>gbrain — connected</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh;background:#0a0a0f;color:#e0e0e0">
<div style="text-align:center"><h1 style="color:#22c55e">Connected</h1>
<p>You can close this tab and return to your agent.</p></div></body></html>`;

const DENIED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>gbrain — not connected</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:90vh;background:#0a0a0f;color:#e0e0e0">
<div style="text-align:center"><h1 style="color:#ef4444">Not connected</h1>
<p>The consent was denied or invalid. Return to your agent for the fix.</p></div></body></html>`;

/**
 * Start the one-shot loopback listener. port 0 (default) = ephemeral.
 * The promise rejects on state mismatch, consent denial, or timeout; the
 * server always closes itself.
 */
export function startLoopback(opts: {
  state: string;
  port?: number;
  timeoutMs?: number;
}): LoopbackHandle {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  let resolveCode: (code: string) => void;
  let rejectCode: (err: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: opts.port ?? 0,
      fetch(req: Request): Response {
        const url = new URL(req.url);
        const params = url.searchParams;
        if (params.get('error')) {
          rejectCode(
            params.get('error') === 'access_denied'
              ? new CredentialError('access_denied_test_user')
              : new CredentialError('upstream', `: consent error ${params.get('error')}`),
          );
          return new Response(DENIED_HTML, { headers: { 'content-type': 'text/html' } });
        }
        const code = params.get('code');
        if (!code) {
          // Favicon probes etc. — not the redirect.
          return new Response('gbrain oauth callback', { status: 404 });
        }
        if (params.get('state') !== opts.state) {
          rejectCode(new CredentialError('state_mismatch'));
          return new Response(DENIED_HTML, { headers: { 'content-type': 'text/html' } });
        }
        resolveCode(code);
        return new Response(SUCCESS_HTML, { headers: { 'content-type': 'text/html' } });
      },
    });
  } catch (e) {
    throw new CredentialError('port_in_use', undefined, e);
  }

  const timer = setTimeout(() => {
    rejectCode(new CredentialError('consent_timeout'));
  }, timeoutMs);

  const close = (): void => {
    clearTimeout(timer);
    try {
      // Graceful stop: a force-stop (stop(true)) resets the in-flight
      // redirect connection BEFORE Bun flushes the final response, so the
      // user's browser shows a connection reset instead of the
      // "Connected" page (caught by test/google-redirect.test.ts).
      server.stop();
    } catch {
      /* already stopped */
    }
  };
  // Whatever settles the promise, the listener dies with it. Both arms
  // handled — a bare .finally() on a rejecting promise creates a derived
  // unhandled rejection.
  codePromise.then(
    () => close(),
    () => close(),
  );

  const boundPort = server.port;
  if (boundPort === undefined) {
    close();
    throw new CredentialError('port_in_use', undefined, 'listener reported no port');
  }
  return {
    redirectUri: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    codePromise,
    close,
  };
}

// ── Browser opening (best-effort, never fatal) ──────────────────────────────

/**
 * Try to open the system browser. Failure is fine — the caller always prints
 * the URL too. No `open` npm dep (house style: no new dependencies).
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const argv =
    platform === 'darwin'
      ? ['open', url]
      : platform === 'win32'
        ? ['cmd', '/c', 'start', '', url.replace(/&/g, '^&')]
        : ['xdg-open', url];
  try {
    Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
