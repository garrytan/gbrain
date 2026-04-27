# Security

## Reporting Vulnerabilities

If you discover a security issue in GBrain, please report it privately:

- **Email:** security@garrytan.com
- **GitHub:** Open a [private security advisory](https://github.com/garrytan/gbrain/security/advisories/new)

Do not open a public issue for security vulnerabilities.

## Remote MCP Security

### ⚠️ Do NOT use open OAuth client registration for remote MCP

If you deploy GBrain's MCP server behind an HTTP wrapper with OAuth 2.1
support, **never allow unauthenticated client registration**. An attacker
who discovers your server URL can:

1. Register a new OAuth client via `POST /register`
2. Use `client_credentials` grant to obtain a bearer token
3. Access all brain data via the MCP tools

### Recommended: `gbrain serve --http`

As of v0.22.5, GBrain ships a built-in HTTP transport that uses the
existing `access_tokens` table for authentication:

```bash
# Create a token
gbrain auth create "my-client"

# Start the HTTP server
gbrain serve --http --port 8787

# Connect via ngrok, Tailscale, or any tunnel
ngrok http 8787 --url your-brain.ngrok.app
```

This is the recommended way to expose GBrain remotely. No OAuth, no
registration endpoint, no self-service tokens. Tokens are managed
exclusively via `gbrain auth create/list/revoke`.

### If you must use a custom HTTP wrapper

1. **Require a secret for client registration** — check a header or body
   parameter before creating new OAuth clients
2. **Disable `client_credentials` grant** — only allow `authorization_code`
   with browser-based approval
3. **Restrict scopes** — never issue tokens with unlimited scope
4. **Log all token issuance** — alert on unexpected registrations
5. **Rate-limit registration and token endpoints**

### Token Management

```bash
gbrain auth create "claude-desktop"   # Create a new token
gbrain auth list                       # List all tokens
gbrain auth revoke "claude-desktop"    # Revoke a token
gbrain auth test <url> --token <tok>   # Smoke-test a remote server
```

Tokens are stored as SHA-256 hashes in the `access_tokens` table. The
plaintext token is shown once at creation and never stored.
