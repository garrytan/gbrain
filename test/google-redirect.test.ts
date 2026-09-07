/**
 * google-redirect — unit tests for the OAuth redirect strategies
 * (src/core/creds/redirect.ts): the headless sniff, paste-back parsing, and
 * the one-shot Bun.serve loopback listener (real ephemeral-port server,
 * exercised with real local fetches; always closed in finally).
 */

import { describe, it, expect } from 'bun:test';

import {
  PASTE_REDIRECT_URI,
  parsePastedRedirect,
  sniffHeadless,
  startLoopback,
} from '../src/core/creds/redirect.ts';
import { CredentialError } from '../src/core/creds/errors.ts';

function expectCodeSync(fn: () => unknown, code: CredentialError['code']): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    expect(e).toBeInstanceOf(CredentialError);
    expect((e as CredentialError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

async function expectRejectsCode(p: Promise<unknown>, code: CredentialError['code']): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    expect(e).toBeInstanceOf(CredentialError);
    expect((e as CredentialError).code).toBe(code);
  }
  expect(threw).toBe(true);
}

// ── sniffHeadless ────────────────────────────────────────────────────────────

describe('sniffHeadless', () => {
  it('SSH session → headless', () => {
    expect(sniffHeadless({ env: { SSH_CONNECTION: 'x' }, platform: 'darwin' })).toBe(true);
  });

  it('WSL → headless', () => {
    expect(sniffHeadless({ env: { WSL_DISTRO_NAME: 'u' }, platform: 'linux' })).toBe(true);
  });

  it('linux with no display server → headless', () => {
    expect(sniffHeadless({ env: {}, platform: 'linux' })).toBe(true);
  });

  it('linux with DISPLAY → not headless', () => {
    expect(sniffHeadless({ env: { DISPLAY: ':0' }, platform: 'linux' })).toBe(false);
  });

  it('darwin with a bare env → not headless', () => {
    expect(sniffHeadless({ env: {}, platform: 'darwin' })).toBe(false);
  });

  it('GBRAIN_FORCE_PASTE=1 forces headless everywhere', () => {
    expect(sniffHeadless({ env: { GBRAIN_FORCE_PASTE: '1' }, platform: 'darwin' })).toBe(true);
  });
});

// ── parsePastedRedirect ──────────────────────────────────────────────────────

describe('parsePastedRedirect', () => {
  it('parses the full failed-to-load redirect URL and decodes the code', () => {
    const parsed = parsePastedRedirect('http://127.0.0.1:41999/?code=4%2Fabc&state=st', 'st');
    expect(parsed.code).toBe('4/abc');
    expect(parsed.state).toBe('st');
  });

  it('accepts a bare authorization code', () => {
    const parsed = parsePastedRedirect('4/xyz');
    expect(parsed.code).toBe('4/xyz');
    expect(parsed.state).toBeNull();
  });

  it('accepts a querystring-only paste', () => {
    const parsed = parsePastedRedirect('code=abc&state=st', 'st');
    expect(parsed.code).toBe('abc');
    expect(parsed.state).toBe('st');
  });

  it('the consent-page URL (accounts.google.com) → pasted_wrong_url', () => {
    expectCodeSync(
      () =>
        parsePastedRedirect(
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=12345-abc.apps.googleusercontent.com',
        ),
      'pasted_wrong_url',
    );
  });

  it('a consent-page URL carrying a stray code= param is still rejected by host, not sniffed as legit', () => {
    // Guards the fix itself from over-correcting to "has a code param" —
    // the decision must stay host-based.
    expectCodeSync(
      () =>
        parsePastedRedirect(
          'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&code=4%2Ffake&state=st',
        ),
      'pasted_wrong_url',
    );
  });

  it('a scheme-less consent-page URL (address bar without https://) → pasted_wrong_url', () => {
    // Browsers hide the scheme in the address bar; the paste then misses the
    // URL branch and must not fall through to the bare-code branch (which
    // skips the state check and hands the whole consent URL to token exchange).
    expectCodeSync(
      () =>
        parsePastedRedirect(
          'accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&state=st&code_challenge=zzz',
          'st',
        ),
      'pasted_wrong_url',
    );
  });

  it('consent-host anchor: look-alike hosts are NOT the consent page and proceed to state binding', () => {
    // The host test is anchored at `^` or a `.` label boundary. A substring
    // test would reject both of these; they are not accounts.google.com, so a
    // code-bearing paste from them parses and binds state like any redirect.
    for (const host of ['myaccounts.google.com', 'accounts.google.com.evil.com']) {
      const parsed = parsePastedRedirect(`https://${host}/o/oauth2/v2/auth?code=4%2Fabc&state=st`, 'st');
      expect(parsed.code).toBe('4/abc');
      expect(parsed.state).toBe('st');
      expectCodeSync(
        () => parsePastedRedirect(`https://${host}/o/oauth2/v2/auth?code=4%2Fabc&state=stale`, 'st'),
        'state_mismatch',
      );
    }
  });

  it('consent-host anchor: a port or userinfo on the consent host is still the consent page', () => {
    // Host normalization drops `user@` and `:port` BEFORE the anchored test.
    // Without that the tail no longer ends in accounts.google.com: the
    // scheme-less+port paste would fall through to the bare-code branch and
    // the userinfo paste would parse as a legitimate redirect.
    expectCodeSync(
      () =>
        parsePastedRedirect(
          'accounts.google.com:443/o/oauth2/v2/auth?client_id=abc&response_type=code&state=st&code_challenge=zzz',
          'st',
        ),
      'pasted_wrong_url',
    );
    expectCodeSync(
      () =>
        parsePastedRedirect(
          'https://x@accounts.google.com/o/oauth2/v2/auth?client_id=abc&code=4%2Ffake&state=st',
          'st',
        ),
      'pasted_wrong_url',
    );
  });

  it('a real loopback redirect carrying RFC 9207 iss=accounts.google.com parses normally (#regression)', () => {
    // Google's OAuth 2.0 authorization response now appends
    // `iss=https://accounts.google.com` (OpenID Connect issuer
    // identification) to EVERY redirect, including legitimate loopback ones.
    // A substring test over the whole raw paste used to reject these.
    const parsed = parsePastedRedirect(
      'http://127.0.0.1:41999/?state=st&iss=https%3A%2F%2Faccounts.google.com&code=4%2Fabc&scope=email',
      'st',
    );
    expect(parsed.code).toBe('4/abc');
    expect(parsed.state).toBe('st');
  });

  it('a querystring-only paste carrying iss=accounts.google.com also parses normally', () => {
    const parsed = parsePastedRedirect(
      'code=4%2Fabc&state=st&iss=https%3A%2F%2Faccounts.google.com',
      'st',
    );
    expect(parsed.code).toBe('4/abc');
    expect(parsed.state).toBe('st');
  });

  it('state mismatch → state_mismatch', () => {
    expectCodeSync(
      () => parsePastedRedirect('http://127.0.0.1:41999/?code=4%2Fabc&state=stale', 'st'),
      'state_mismatch',
    );
  });

  it('a full-URL paste MISSING the state param → state_mismatch (CSRF binding); bare code stays accepted', () => {
    // A full redirect URL / querystring paste MUST carry the matching state.
    expectCodeSync(
      () => parsePastedRedirect('http://127.0.0.1:41999/?code=4%2Fabc', 'st'),
      'state_mismatch',
    );
    expectCodeSync(() => parsePastedRedirect('code=4%2Fabc', 'st'), 'state_mismatch');
    // Only a bare-code paste legitimately has no state — PKCE's code-verifier
    // binding is the remaining defense there.
    const bare = parsePastedRedirect('4/xyz', 'st');
    expect(bare.code).toBe('4/xyz');
    expect(bare.state).toBeNull();
  });

  it('error=access_denied in the query → access_denied_test_user', () => {
    expectCodeSync(
      () => parsePastedRedirect('http://127.0.0.1:41999/?error=access_denied&state=st', 'st'),
      'access_denied_test_user',
    );
  });

  it('empty paste → pasted_wrong_url', () => {
    expectCodeSync(() => parsePastedRedirect('   '), 'pasted_wrong_url');
  });

  it('PASTE_REDIRECT_URI is the fixed loopback used in paste mode', () => {
    expect(PASTE_REDIRECT_URI).toBe('http://127.0.0.1:41999/');
  });
});

// ── startLoopback ────────────────────────────────────────────────────────────
//
// The src fix landed: close() is a graceful `server.stop()` (the final HTTP
// response flushes before the listener dies) and the promise-settled cleanup
// handles BOTH arms via `.then(close, close)` (no derived unhandled
// rejection). The success/denied page-body assertions below are therefore
// unconditional, and no Promise.prototype.finally patching is needed.

describe('startLoopback', () => {
  it('resolves the code on a matching state and delivers the success page', async () => {
    const handle = startLoopback({ state: 'st-good' });
    try {
      expect(handle.redirectUri).toBe(`http://127.0.0.1:${handle.port}/`);
      const res = await fetch(`http://127.0.0.1:${handle.port}/?code=abc&state=st-good`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Connected');
      await expect(handle.codePromise).resolves.toBe('abc');
    } finally {
      handle.close();
    }
  });

  it('rejects with state_mismatch on a wrong state and delivers the denied page', async () => {
    const handle = startLoopback({ state: 'st-expected' });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/?code=abc&state=st-wrong`);
      // The browser gets the "Not connected" page, never the success page.
      const body = await res.text();
      expect(body).toContain('Not connected');
      expect(body).not.toContain('>Connected<');
      await expectRejectsCode(handle.codePromise, 'state_mismatch');
    } finally {
      handle.close();
    }
  });

  it('rejects with access_denied_test_user on ?error=access_denied (denied page delivered)', async () => {
    const handle = startLoopback({ state: 'st-denied' });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/?error=access_denied&state=st-denied`);
      expect(await res.text()).toContain('Not connected');
      await expectRejectsCode(handle.codePromise, 'access_denied_test_user');
    } finally {
      handle.close();
    }
  });

  it('a favicon probe (no code param) gets a 404 and leaves the promise pending', async () => {
    const handle = startLoopback({ state: 'st-favicon' });
    try {
      // The probe does not settle the promise; this response must be a 404.
      const res = await fetch(`http://127.0.0.1:${handle.port}/favicon.ico`);
      expect(res.status).toBe(404);
      // The code promise must NOT have settled — race it against a short delay.
      const outcome = await Promise.race([
        handle.codePromise.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(outcome).toBe('pending');
      // The listener is still live after the probe: a real redirect still works.
      const res2 = await fetch(`http://127.0.0.1:${handle.port}/?code=late&state=st-favicon`);
      expect(await res2.text()).toContain('Connected');
      await expect(handle.codePromise).resolves.toBe('late');
    } finally {
      handle.close();
    }
  });

  it('rejects with consent_timeout when nothing arrives within timeoutMs', async () => {
    const handle = startLoopback({ state: 'st-timeout', timeoutMs: 50 });
    try {
      await expectRejectsCode(handle.codePromise, 'consent_timeout');
    } finally {
      handle.close();
    }
  });

  it('a busy port → CredentialError port_in_use (thrown synchronously)', () => {
    // Squat an ephemeral port first, then ask startLoopback for exactly it.
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    try {
      expectCodeSync(() => startLoopback({ state: 'st-busy', port: squatter.port }), 'port_in_use');
    } finally {
      squatter.stop(true);
    }
  });
});
