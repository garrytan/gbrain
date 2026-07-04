#!/bin/bash
# Deploy MBrain Remote MCP Server to Supabase Edge Functions.
# Prerequisites: .env.production filled in, supabase CLI installed.
set -e

# Check supabase CLI
if ! command -v supabase >/dev/null 2>&1; then
  echo "Error: supabase CLI not found."
  echo "Install: brew install supabase/tap/supabase"
  echo "    or:  npm install -g supabase"
  exit 1
fi

# Load env
if [ ! -f .env.production ]; then
  echo "Error: .env.production not found."
  echo "Copy .env.production.example to .env.production and fill in your values."
  exit 1
fi
source .env.production

if [ -z "$SUPABASE_PROJECT_REF" ]; then
  echo "Error: SUPABASE_PROJECT_REF not set in .env.production"
  exit 1
fi

echo "Deploying MBrain Remote MCP Server..."
echo "  Project: $SUPABASE_PROJECT_REF"
echo ""

# Link project
supabase link --project-ref "$SUPABASE_PROJECT_REF"

# Set secrets
supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"

# Build the Edge Function bundle
echo ""
echo "Building Edge Function bundle..."
bun install
bun run build:edge
echo ""

# Apply schema migrations before new Edge code starts serving requests.
REMOTE_DATABASE_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [ -z "$REMOTE_DATABASE_URL" ]; then
  echo "Error: SUPABASE_DB_URL or DATABASE_URL must be set in .env.production for schema migration."
  exit 1
fi
echo "Applying remote schema migrations..."
TMP_MBR_CONFIG_DIR="$(mktemp -d)"
cleanup_tmp_mbr_config() {
  rm -rf "$TMP_MBR_CONFIG_DIR"
}
trap cleanup_tmp_mbr_config EXIT
MBRAIN_CONFIG_DIR="$TMP_MBR_CONFIG_DIR" bun run src/cli.ts init --non-interactive --url "$REMOTE_DATABASE_URL"
cleanup_tmp_mbr_config
trap - EXIT
echo ""

# Deploy
echo "Deploying Edge Function..."
supabase functions deploy mbrain-mcp --no-verify-jwt
echo ""

# Print success
URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/mbrain-mcp/mcp"
echo "================================================"
echo "  MBrain Remote MCP Server deployed!"
echo "================================================"
echo ""
echo "  URL: $URL"
echo ""
echo "  Next steps:"
echo "    1. Create a token:"
echo "       DATABASE_URL=\$DATABASE_URL bun run src/commands/auth.ts create \"my-client\""
echo ""
echo "    2. Test it:"
echo "       bun run src/commands/auth.ts test $URL --token <your-token>"
echo ""
echo "    3. Add to Claude Code:"
echo "       claude mcp add mbrain -t http $URL -H \"Authorization: Bearer <token>\""
echo ""
echo "  See docs/mcp/ for per-client setup guides."
