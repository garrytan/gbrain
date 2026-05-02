#!/usr/bin/env bash
set -euo pipefail

# Configure HTTPS for a self-hosted GBrain MCP server behind Nginx.
#
# Usage:
#   sudo bash scripts/setup-gbrain-ssl.sh brain.elzodxon.uz 8787 admin@example.com
#
# Requirements:
# - Nginx installed and running
# - DNS for the domain points to this server
# - `gbrain serve --http` is running on PORT (Postgres-backed brain required)

DOMAIN="${1:?Usage: $0 <domain> <port> <email>}"
PORT="${2:-8787}"
EMAIL="${3:-admin@${DOMAIN}}"

if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  echo "Refusing suspicious domain: $DOMAIN" >&2
  exit 1
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "Invalid port: $PORT" >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root (sudo $0 ...)." >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is required. Install it first." >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot is required. Install python3-certbot-nginx (or distro equivalent)." >&2
  exit 1
fi

if ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${PORT}$"; then
  echo "Warning: no service currently listening on port $PORT."
  echo "Start gbrain with a Postgres-backed engine first: gbrain serve --http --host 0.0.0.0 --port $PORT"
fi

NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
ENABLED_CONF="/etc/nginx/sites-enabled/${DOMAIN}.conf"
WEBROOT="/var/www/html"

mkdir -p "$WEBROOT"

# First install an HTTP-only config so nginx -t does not depend on a certificate
# that has not been issued yet.
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 200 'GBrain MCP TLS bootstrap for ${DOMAIN}\n';
        add_header Content-Type text/plain;
    }
}
EOF

if [[ -e "$ENABLED_CONF" && ! -L "$ENABLED_CONF" ]]; then
  echo "Refusing to replace non-symlink enabled site: $ENABLED_CONF" >&2
  exit 1
fi
ln -sfn "$NGINX_CONF" "$ENABLED_CONF"

nginx -t
systemctl reload nginx

certbot certonly --webroot -w "$WEBROOT" -d "${DOMAIN}" --non-interactive --agree-tos --email "${EMAIL}"

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1h;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # gbrain MCP endpoint
    location /mcp {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Compatibility for clients still hitting /api/mcp
    location /api/mcp {
        proxy_pass http://127.0.0.1:${PORT}/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Optional health endpoint for external checks
    location /health {
        proxy_pass http://127.0.0.1:${PORT}/health;
        proxy_http_version 1.1;
    }

    # Keep unexpected paths from exposing app internals
    location / {
        return 404;
    }
}
EOF

nginx -t
systemctl reload nginx

echo "HTTPS enabled for https://${DOMAIN}"
echo "MCP URL: https://${DOMAIN}/mcp"
echo "Add in Claude: Authorization Bearer <token> against that URL."
