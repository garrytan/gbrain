# Self-Hosted Remote MCP

This guide runs GBrain's HTTP MCP transport on a VPS with:

- Docker Postgres 17 + pgvector
- `gbrain serve --http`
- systemd
- Nginx + Let's Encrypt

Remote MCP requires a Postgres-backed brain. PGLite is local-only and cannot
store remote bearer tokens.

## 1. Configure Secrets

Create a local env file from `.env.selfhost.example` and fill in real values.
Keep it out of git.

```bash
cp .env.selfhost.example .env
chmod 600 .env
set -a
. ./.env
set +a
```

Use a strong `POSTGRES_PASSWORD`. Do not put root passwords in this file; use
sudo, SSH keys, or your server secret manager for host access.

## 2. Start Postgres

```bash
docker compose -f deploy/docker-compose.remote.yml --env-file .env up -d
```

Wait for the health check:

```bash
docker compose -f deploy/docker-compose.remote.yml --env-file .env ps
```

## 3. Initialize Or Migrate GBrain

For a fresh remote brain:

```bash
GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain init --non-interactive
```

To move an existing PGLite brain to Postgres:

```bash
gbrain migrate --to supabase --url "$GBRAIN_DATABASE_URL"
```

## 4. Create A Bearer Token

```bash
DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain auth create "claude-desktop"
```

Save the token once. It is stored hashed in Postgres and cannot be recovered
later.

## 5. Install The systemd Service

Create a runtime user and service environment:

```bash
sudo useradd --system --create-home --home-dir /var/lib/gbrain --shell /usr/sbin/nologin gbrain
sudo mkdir -p /etc/gbrain
sudo install -m 600 .env /etc/gbrain/gbrain-mcp.env
sudo cp deploy/gbrain-mcp.service /etc/systemd/system/gbrain-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now gbrain-mcp
```

The example service expects `gbrain` to be available in the service user's
`PATH`. Install it for that user, symlink the binary into `/usr/local/bin`, or
adjust `PATH` / `ExecStart` before starting the service.

## 6. Add HTTPS

Point DNS for your domain to the server first, then run:

```bash
sudo bash scripts/setup-gbrain-ssl.sh "$GBRAIN_DOMAIN" "$GBRAIN_HTTP_PORT" "$LETSENCRYPT_EMAIL"
```

The script exposes:

- `https://$GBRAIN_DOMAIN/mcp`
- `https://$GBRAIN_DOMAIN/api/mcp` for compatibility with clients using that path
- `https://$GBRAIN_DOMAIN/health`

## 7. Verify

```bash
curl -sS "https://$GBRAIN_DOMAIN/health"
gbrain auth test "https://$GBRAIN_DOMAIN/mcp" --token "$GBRAIN_MCP_TOKEN"
```

For Claude Code:

```bash
claude mcp add gbrain -t http "https://$GBRAIN_DOMAIN/mcp" \
  -H "Authorization: Bearer $GBRAIN_MCP_TOKEN"
```
