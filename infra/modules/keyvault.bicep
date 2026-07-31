// Key Vault holding every secret the container apps read, plus the role
// assignment that lets them.
//
// RBAC authorization rather than access policies: access policies are the
// legacy model, cannot be scoped per-secret, and do not show up in
// subscription-wide access reviews. `Key Vault Secrets User` is read-only on
// secret VALUES — the identity cannot list, set, or delete.
//
// Secrets are written here at deploy time and referenced by the container
// apps as versionless URIs, so rotating a secret is `az keyvault secret set`
// plus a revision restart, with no template change.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Principal id of the identity that reads these secrets.')
param readerPrincipalId string

@description('PostgreSQL connection string, including sslmode=require and port 5432.')
@secure()
param databaseUrl string

@description('Admin bootstrap token. Must match ^[A-Za-z0-9_-]{32,}$ or gbrain refuses to start.')
@secure()
param adminBootstrapToken string

@description('Name of the AI Foundry account whose key becomes the Claude credential.')
param foundryAccountName string

@description('Name of the Azure OpenAI account whose key becomes the embedding credential.')
param openAiAccountName string

// The two model-plane keys are resolved HERE rather than passed in.
//
// Module outputs are recorded in the resource group's deployment history and
// readable by anyone holding deployment-read, so a module that returned an
// API key would publish it to a wider audience than the vault it is destined
// for. Reading the keys inside the module that writes them keeps them off
// every boundary in between.
resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: foundryAccountName
}

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAiAccountName
}

// Key Vault names are globally unique, 3-24 chars, alphanumeric and dashes.
// uniqueString on the resource group id keeps redeploys stable while
// avoiding a collision with someone else's vault.
var vaultName = take('kv-${namePrefix}-${uniqueString(resourceGroup().id)}', 24)

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    // Soft delete is not optional on current API versions; purge protection
    // is. Left off deliberately: with it on, a deleted vault name is
    // unusable for 90 days, which turns a teardown-and-retry of this
    // template into a multi-month block. Turn it on for anything holding
    // secrets that cannot be reissued.
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

// Built-in role definition id for "Key Vault Secrets User". Hardcoded
// because built-in role ids are stable, tenant-independent GUIDs.
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource secretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  // Deterministic GUID: re-running the deployment must update the same
  // assignment rather than fail on a duplicate.
  name: guid(vault.id, readerPrincipalId, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'gbrain-database-url'
  properties: {
    value: databaseUrl
  }
}

resource adminBootstrapTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'gbrain-admin-bootstrap-token'
  properties: {
    value: adminBootstrapToken
  }
}

resource anthropicApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'anthropic-api-key'
  properties: {
    value: foundryAccount.listKeys().key1
  }
}

resource azureOpenAiApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'azure-openai-api-key'
  properties: {
    value: openAiAccount.listKeys().key1
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri

// Versionless secret URIs. Versionless on purpose: a rotated secret is
// picked up by restarting the revision, with no redeploy of this template.
output databaseUrlSecretUri string = '${vault.properties.vaultUri}secrets/${databaseUrlSecret.name}'
output adminBootstrapTokenSecretUri string = '${vault.properties.vaultUri}secrets/${adminBootstrapTokenSecret.name}'
output anthropicApiKeySecretUri string = '${vault.properties.vaultUri}secrets/${anthropicApiKeySecret.name}'
output azureOpenAiApiKeySecretUri string = '${vault.properties.vaultUri}secrets/${azureOpenAiApiKeySecret.name}'

// Exposed so dependent modules can order themselves after the grant. A
// container app that starts before the role assignment propagates fails its
// first secret resolution.
output roleAssignmentId string = secretsUserAssignment.id
