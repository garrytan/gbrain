#!/usr/bin/env bash
# GBrain Azure Deployment Script
# Usage: ./scripts/deploy-azure.sh
# Prerequisites: az CLI installed + logged in, Docker running

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
RESOURCE_GROUP="gbrain-rg"
LOCATION="eastus"
ACR_NAME="gbrainacr"                        # must be globally unique, lowercase, no hyphens
PG_SERVER="gbrain-postgres"
PG_DB="gbrain"
PG_USER="gbrain_admin"
CONTAINER_ENV="gbrain-env"
APP_NAME="gbrain"
PORT=3131
# ──────────────────────────────────────────────────────────────────────────────

# Require passwords as env vars (never hardcode secrets)
: "${PG_PASSWORD:?Set PG_PASSWORD env var before running}"
: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY env var before running}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY env var before running}"

echo "==> [1/8] Creating resource group: $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> [2/8] Creating Azure Container Registry: $ACR_NAME"
az acr create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --sku Basic \
  --admin-enabled true \
  --output none

echo "==> [3/8] Creating Azure PostgreSQL Flexible Server"
az postgres flexible-server create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER" \
  --location "$LOCATION" \
  --admin-user "$PG_USER" \
  --admin-password "$PG_PASSWORD" \
  --sku-name Standard_D2s_v3 \
  --tier GeneralPurpose \
  --version 16 \
  --storage-size 32 \
  --output none || echo "[skip] Postgres server may already exist"

echo "==> [3a] Allowing Azure services to connect"
az postgres flexible-server firewall-rule create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER" \
  --rule-name allow-azure-internal \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0 \
  --output none || true

echo "==> [3b] Creating database: $PG_DB"
az postgres flexible-server db create \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER" \
  --database-name "$PG_DB" \
  --output none || true

echo "==> [3c] Enabling pgvector, pg_trgm, btree_gin extensions"
az postgres flexible-server parameter set \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER" \
  --name azure.extensions \
  --value "VECTOR,PG_TRGM,BTREE_GIN" \
  --output none

echo "==> [4/8] Building and pushing Docker image"
az acr login --name "$ACR_NAME"
ACR_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)

docker build \
  --platform linux/amd64 \
  -t "$ACR_SERVER/$APP_NAME:latest" \
  "$(dirname "$0")/.."

docker push "$ACR_SERVER/$APP_NAME:latest"

echo "==> [5/8] Creating Container Apps environment"
az containerapp env create \
  --name "$CONTAINER_ENV" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none || echo "[skip] Environment may already exist"

echo "==> [6/8] Getting ACR credentials"
ACR_USERNAME=$(az acr credential show --name "$ACR_NAME" --query username -o tsv)
ACR_PASSWORD_VAL=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_SERVER}.postgres.database.azure.com/${PG_DB}?sslmode=require"

echo "==> [7/8] Deploying GBrain Container App"
az containerapp create \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$CONTAINER_ENV" \
  --image "$ACR_SERVER/$APP_NAME:latest" \
  --registry-server "$ACR_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD_VAL" \
  --target-port $PORT \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 1.0 \
  --memory 2.0Gi \
  --secrets \
    "db-url=${DATABASE_URL}" \
    "anthropic-key=${ANTHROPIC_API_KEY}" \
    "openai-key=${OPENAI_API_KEY}" \
  --env-vars \
    DATABASE_URL=secretref:db-url \
    ANTHROPIC_API_KEY=secretref:anthropic-key \
    OPENAI_API_KEY=secretref:openai-key \
    GBRAIN_ENGINE=postgres \
    GBRAIN_HOME=/data/gbrain \
  --output none || \
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "$ACR_SERVER/$APP_NAME:latest" \
  --output none

echo "==> [8/8] Initializing GBrain schema"
az containerapp job create \
  --name "gbrain-init" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$CONTAINER_ENV" \
  --trigger-type Manual \
  --replica-timeout 300 \
  --image "$ACR_SERVER/$APP_NAME:latest" \
  --registry-server "$ACR_SERVER" \
  --registry-username "$ACR_USERNAME" \
  --registry-password "$ACR_PASSWORD_VAL" \
  --command "gbrain" \
  --args "apply-migrations,--yes" \
  --secrets "db-url=${DATABASE_URL}" \
  --env-vars \
    DATABASE_URL=secretref:db-url \
    GBRAIN_ENGINE=postgres \
    GBRAIN_HOME=/data/gbrain \
  --output none 2>/dev/null || true

az containerapp job start --name "gbrain-init" --resource-group "$RESOURCE_GROUP" --output none

echo ""
echo "==> Done! Getting your GBrain URL..."
FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn \
  -o tsv)

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "  GBrain is live at: https://$FQDN"
echo "  Admin dashboard:   https://$FQDN/admin"
echo "  Health check:      https://$FQDN/health"
echo "  MCP endpoint:      https://$FQDN/mcp"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Next: create your first OAuth client:"
echo "  gbrain auth register-client 'hackathon-demo' --grant-types client_credentials --scopes read,write"
echo ""
echo "Set the public URL for OAuth:"
echo "  az containerapp update --name $APP_NAME --resource-group $RESOURCE_GROUP \\"
echo "    --set-env-vars GBRAIN_PUBLIC_URL=https://$FQDN"
