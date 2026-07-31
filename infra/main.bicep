// gbrain on Azure — subscription-scope entry point.
//
// Creates the resource group and wires every module. Deploy with:
//
//   az deployment sub create \
//     --name gbrain-$(date +%Y%m%d%H%M%S) \
//     --location eastus2 \
//     --template-file infra/main.bicep \
//     --parameters infra/main.parameters.json \
//     --parameters dbAdminPassword=... adminBootstrapToken=...
//
// ORDER OF OPERATIONS. This template does NOT deploy the container apps on
// the first run, and that is deliberate rather than an omission. A container
// app cannot be created without an image, the image cannot be built until
// the registry exists, and the schema must be migrated before a serving
// revision starts. So:
//
//   1. Deploy with deployApps=false  → foundation + registry + model plane
//   2. Build and push the image      → .github/workflows/deploy.yml
//   3. Run the migration job         → az containerapp job start
//   4. Deploy with deployApps=true   → serving apps, pointed at the image
//
// Steps 2-4 are what deploy.yml automates. Re-running this template with
// deployApps=true is idempotent.

targetScope = 'subscription'

@description('Azure region. East US 2 carries both Claude hosting tiers at the lowest US price band with full Azure OpenAI coverage.')
param location string = 'eastus2'

@description('Resource name prefix. Appears in every resource name.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'gbrain'

@description('Resource group name.')
param resourceGroupName string = 'rg-${namePrefix}'

@description('PostgreSQL administrator password. Pass at deploy time; never commit it.')
@secure()
param dbAdminPassword string

@description('''
Admin bootstrap token. gbrain validates it against ^[A-Za-z0-9_-]{32,}$ and
REFUSES TO START if it does not match, so a short value fails the deployment
at container start rather than at template validation.

Still required even though the admin plane is disabled on the MCP app: the
process validates the token before it consults GBRAIN_DISABLE_ADMIN.
''')
@secure()
@minLength(32)
param adminBootstrapToken string

@description('Public URL clients reach the MCP server at. Leave empty to use the Container Apps default FQDN, which is only known after the first apps deployment.')
param publicUrl string = ''

@description('Deploy the serving apps and migration job. False on the first run — there is no image yet. See the header.')
param deployApps bool = false

@description('Fully qualified image reference. Required when deployApps is true.')
param image string = ''

@description('Worker replicas. 1 running, 0 stopped for the scheduled off-hours window. Never above 1 — two supervisors race on job leases.')
@minValue(0)
@maxValue(1)
param workerReplicas int = 1

@description('Postgres compute SKU.')
param postgresSkuName string = 'Standard_B2s'

@description('Postgres SKU tier.')
param postgresSkuTier string = 'Burstable'

@description('Postgres provisioned storage in GB. Grows but never shrinks.')
param postgresStorageGB int = 32

@description('Create the Claude deployments declaratively. Leave false until a Marketplace purchase path is confirmed — see infra/modules/foundry.bicep.')
param deployClaude bool = false

@description('Chat model gbrain routes to, as a gateway model string.')
param chatModel string = 'anthropic:claude-sonnet-5'

@description('Expansion model. Not exercised under search.mode=conservative, but configured so a mode change does not 404.')
param expansionModel string = 'anthropic:claude-haiku-4-5'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
}

module network 'modules/network.bicep' = {
  scope: rg
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module identity 'modules/identity.bicep' = {
  scope: rg
  name: 'identity'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module observability 'modules/observability.bicep' = {
  scope: rg
  name: 'observability'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module postgres 'modules/postgres.bicep' = {
  scope: rg
  name: 'postgres'
  params: {
    location: location
    namePrefix: namePrefix
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresDnsZoneId
    administratorPassword: dbAdminPassword
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageGB
  }
}

module acr 'modules/acr.bicep' = {
  scope: rg
  name: 'acr'
  params: {
    location: location
    namePrefix: namePrefix
    pullPrincipalId: identity.outputs.principalId
  }
}

module foundry 'modules/foundry.bicep' = {
  scope: rg
  name: 'foundry'
  params: {
    location: location
    namePrefix: namePrefix
    deployClaude: deployClaude
  }
}

// Port 5432, NOT 6432. Azure's PgBouncer runs on 6432, but gbrain keys its
// prepared-statement auto-disable on port 6543 (Supabase's) and gates its
// dual-pool machinery on a Supabase-shaped URL — so behind a transaction-mode
// pooler, executeRawDirect silently collapses onto the shared read pool,
// taking minion lock heartbeats and sync checkpoints with it. Direct 5432
// also avoids the startup-parameter allowlist problem, since gbrain sends
// statement_timeout and idle_in_transaction_session_timeout as connection
// startup parameters. (Burstable does not offer PgBouncer anyway.)
var databaseUrl = 'postgresql://${postgres.outputs.administratorLogin}:${uriComponent(dbAdminPassword)}@${postgres.outputs.fullyQualifiedDomainName}:5432/${postgres.outputs.databaseName}?sslmode=require'

module keyvault 'modules/keyvault.bicep' = {
  scope: rg
  name: 'keyvault'
  params: {
    location: location
    namePrefix: namePrefix
    readerPrincipalId: identity.outputs.principalId
    databaseUrl: databaseUrl
    adminBootstrapToken: adminBootstrapToken
    foundryAccountName: foundry.outputs.foundryName
    openAiAccountName: foundry.outputs.openAiName
  }
}

module containerAppsEnv 'modules/containerapps-env.bicep' = {
  scope: rg
  name: 'containerapps-env'
  params: {
    location: location
    namePrefix: namePrefix
    infrastructureSubnetId: network.outputs.acaSubnetId
    logAnalyticsWorkspaceId: observability.outputs.workspaceId
    logAnalyticsCustomerId: observability.outputs.customerId
  }
}

// Secrets both apps and the migration job expose. Same list everywhere: the
// worker needs the model credentials for cycle phases, and the migration job
// needs the database URL.
var secretRefs = [
  {
    name: 'gbrain-database-url'
    keyVaultUrl: keyvault.outputs.databaseUrlSecretUri
  }
  {
    name: 'gbrain-admin-bootstrap-token'
    keyVaultUrl: keyvault.outputs.adminBootstrapTokenSecretUri
  }
  {
    name: 'anthropic-api-key'
    keyVaultUrl: keyvault.outputs.anthropicApiKeySecretUri
  }
  {
    name: 'azure-openai-api-key'
    keyVaultUrl: keyvault.outputs.azureOpenAiApiKeySecretUri
  }
]

// Environment shared by both apps and the migration job. Defined once here
// rather than per-module: a variable that drifts between the MCP app and the
// worker is a class of bug that only shows up as one of them behaving
// differently under load.
var sharedEnv = [
  {
    name: 'GBRAIN_DATABASE_URL'
    secretRef: 'gbrain-database-url'
  }
  {
    // Well under what B2s permits. The pooler is not in the path, so this
    // is the real server-side connection count per replica.
    name: 'GBRAIN_POOL_SIZE'
    value: '6'
  }
  {
    // HOME and GBRAIN_HOME are BOTH set, to the same value, on purpose.
    // gbrain resolves its home three ways that disagree: config.ts appends
    // `.gbrain` to GBRAIN_HOME, brain-repo-durability.ts does not, and the
    // minion supervisor ignores GBRAIN_HOME entirely and uses
    // $HOME/.gbrain. Setting only one leaves a component writing somewhere
    // nobody reads.
    name: 'HOME'
    value: '/data'
  }
  {
    name: 'GBRAIN_HOME'
    value: '/data'
  }
  {
    // Absolute, not inferred, for the same reason. Note /data is ephemeral:
    // this JSONL is destroyed on every restart, which is why Log Analytics
    // is the durable audit sink and a required resource.
    name: 'GBRAIN_AUDIT_DIR'
    value: '/data/.gbrain/audit'
  }
  {
    // Claude via Foundry. Two environment variables and no transport code:
    // this normalizes to `/anthropic/v1`, and @ai-sdk/anthropic appends
    // `/messages` and sends the key as x-api-key.
    name: 'ANTHROPIC_BASE_URL'
    value: foundry.outputs.anthropicBaseUrl
  }
  {
    name: 'ANTHROPIC_API_KEY'
    secretRef: 'anthropic-api-key'
  }
  {
    name: 'GBRAIN_CHAT_MODEL'
    value: chatModel
  }
  {
    name: 'GBRAIN_EXPANSION_MODEL'
    value: expansionModel
  }
  {
    name: 'GBRAIN_EMBEDDING_MODEL'
    value: 'azure-openai:${foundry.outputs.embeddingDeploymentName}'
  }
  {
    // 1536, never 3072 — above 2000 dims pgvector refuses to build an HNSW
    // index and gbrain emits a SQL comment instead of one, so the brain
    // sequential-scans forever with no error at any layer.
    name: 'GBRAIN_EMBEDDING_DIMENSIONS'
    value: string(foundry.outputs.embeddingDimensions)
  }
  {
    name: 'AZURE_OPENAI_ENDPOINT'
    value: foundry.outputs.openAiEndpoint
  }
  {
    name: 'AZURE_OPENAI_DEPLOYMENT'
    value: foundry.outputs.embeddingDeploymentName
  }
  {
    name: 'AZURE_OPENAI_API_KEY'
    secretRef: 'azure-openai-api-key'
  }
]

// Falls back to the environment's default domain so the first deployment
// does not need a custom domain to exist. Swap in a real hostname once DNS
// is set up; the OAuth issuer follows it.
var resolvedPublicUrl = empty(publicUrl)
  ? 'https://ca-${namePrefix}-mcp.${containerAppsEnv.outputs.defaultDomain}'
  : publicUrl

module migrateJob 'modules/job-migrate.bicep' = if (deployApps) {
  scope: rg
  name: 'job-migrate'
  params: {
    location: location
    namePrefix: namePrefix
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: identity.outputs.id
    registryLoginServer: acr.outputs.loginServer
    image: image
    secretRefs: secretRefs
    sharedEnv: sharedEnv
  }
}

module mcpApp 'modules/containerapp-mcp.bicep' = if (deployApps) {
  scope: rg
  name: 'containerapp-mcp'
  params: {
    location: location
    namePrefix: namePrefix
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: identity.outputs.id
    registryLoginServer: acr.outputs.loginServer
    image: image
    secretRefs: secretRefs
    sharedEnv: sharedEnv
    publicUrl: resolvedPublicUrl
  }
}

module workerApp 'modules/containerapp-worker.bicep' = if (deployApps) {
  scope: rg
  name: 'containerapp-worker'
  params: {
    location: location
    namePrefix: namePrefix
    environmentId: containerAppsEnv.outputs.environmentId
    identityId: identity.outputs.id
    registryLoginServer: acr.outputs.loginServer
    image: image
    secretRefs: secretRefs
    sharedEnv: sharedEnv
    replicas: workerReplicas
  }
}

output resourceGroupName string = rg.name
output registryLoginServer string = acr.outputs.loginServer
output postgresFqdn string = postgres.outputs.fullyQualifiedDomainName
output keyVaultName string = keyvault.outputs.vaultName
output containerAppsEnvironmentId string = containerAppsEnv.outputs.environmentId
output containerAppsDefaultDomain string = containerAppsEnv.outputs.defaultDomain
output anthropicBaseUrl string = foundry.outputs.anthropicBaseUrl
output openAiEndpoint string = foundry.outputs.openAiEndpoint
output publicUrl string = resolvedPublicUrl
// `mcpApp!` because the module is conditional: without the null-forgiving
// operator Bicep can't see that the ternary already guards the access.
output mcpFqdn string = deployApps ? mcpApp!.outputs.fqdn : ''
