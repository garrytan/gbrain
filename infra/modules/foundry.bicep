// The model plane: AI Foundry (Claude) + Azure OpenAI (embeddings).
//
// PARTIALLY DECLARATIVE ON PURPOSE. The Azure OpenAI embedding deployment is
// expressible as ARM and is created here. The Claude deployment is NOT,
// because it requires an Azure Marketplace purchase and agreement acceptance
// that has no ARM representation — attempting it inside the template makes
// the whole deployment fail on a fresh subscription. Deploy Claude from the
// portal or CLI and leave `deployClaude` false until you have confirmed a
// path that works on your subscription.
//
// THE HOSTING-TIER TRAP. Foundry offers Claude in two hosting versions.
// Version 1 is "hosted on Anthropic infrastructure" — it runs OUTSIDE Azure
// and merely bills through it. Version 2 is "Hosted on Azure" and runs on
// Azure end to end. Only v2 keeps prompts inside the Azure boundary; v1
// looks Azure-native on the invoice while sending every prompt out. Verify
// the tier in the portal after creating the deployment — the resulting
// resource looks identical either way.
//
// THE DEPLOYMENT-NAME TRAP. On Foundry the wire `model` field carries the
// DEPLOYMENT name, and deployment names are immutable after creation.
// gbrain's anthropic recipe resolves the alias `claude-haiku-4-5` to the
// dated `claude-haiku-4-5-20251001`, and the resolved id is what goes on the
// wire. So name the Haiku deployment with the dated form, or set the
// expansion model config to the dated id explicitly. Getting it wrong 404s
// at the first query with an opaque error.

@description('Azure region. East US 2 is the only region carrying both Claude hosting tiers at the lowest US price band, with full Azure OpenAI coverage.')
param location string = 'eastus2'

@description('Resource name prefix.')
param namePrefix string

@description('Embedding model. MUST stay at 1536 dimensions — see embeddingDimensions.')
param embeddingModel string = 'text-embedding-3-small'

@description('Embedding model version.')
param embeddingModelVersion string = '1'

@description('''
Embedding width. 1536, never 3072.

pgvector refuses hnsw/ivfflat above 2000 dimensions, and gbrain's
chunkEmbeddingIndexSql silently emits a SQL COMMENT instead of an index above
that width. A text-embedding-3-large brain at its native 3072 therefore
stores fine and then sequential-scans forever, with no error at any layer.
''')
@allowed([1536])
param embeddingDimensions int = 1536

@description('Capacity in thousands of tokens per minute for the embedding deployment.')
param embeddingCapacity int = 50

@description('Create the Claude deployment declaratively. Leave false until a Marketplace purchase path is confirmed on your subscription — see the header.')
param deployClaude bool = false

@description('Claude chat deployment name. Must match the model id gbrain sends.')
param claudeChatDeploymentName string = 'claude-sonnet-5'

@description('Claude expansion deployment name. Dated form on purpose — see the header.')
param claudeExpansionDeploymentName string = 'claude-haiku-4-5-20251001'

// Azure OpenAI — embeddings.
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'oai-${namePrefix}'
  location: location
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    // The subdomain is what makes the {ENDPOINT}/openai/deployments/{name}
    // URL shape work; without it the account only answers on the regional
    // endpoint, which the recipe does not template.
    customSubDomainName: 'oai-${namePrefix}-${uniqueString(resourceGroup().id)}'
    publicNetworkAccess: 'Enabled'
    // Local (key) auth stays enabled: gbrain's azure-openai recipe reaches
    // Entra auth by shelling out to `az account get-access-token`, and
    // there is no Azure CLI in the container image. Managed identity for
    // the model plane would be a rewrite to IMDS, not a config toggle.
    disableLocalAuth: false
  }
}

resource embeddingDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openAi
  name: embeddingModel
  sku: {
    name: 'Standard'
    capacity: embeddingCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: embeddingModel
      version: embeddingModelVersion
    }
  }
}

// AI Foundry — Claude.
resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'aif-${namePrefix}'
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'aif-${namePrefix}-${uniqueString(resourceGroup().id)}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
  }
}

resource claudeChat 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (deployClaude) {
  parent: foundry
  name: claudeChatDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: claudeChatDeploymentName
      version: '1'
    }
  }
}

resource claudeExpansion 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (deployClaude) {
  parent: foundry
  name: claudeExpansionDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'Anthropic'
      name: claudeExpansionDeploymentName
      version: '1'
    }
  }
  dependsOn: [
    claudeChat
  ]
}

output openAiEndpoint string = openAi.properties.endpoint
output openAiName string = openAi.name
output embeddingDeploymentName string = embeddingDeployment.name
output embeddingDimensions int = embeddingDimensions

output foundryName string = foundry.name

// The base URL gbrain's `anthropic` recipe is pointed at. `/anthropic`
// normalizes to `/anthropic/v1`, and @ai-sdk/anthropic appends `/messages`
// and sends the key as x-api-key — Foundry's documented Claude contract,
// with no transport code.
output anthropicBaseUrl string = '${replace(foundry.properties.endpoint, '/cognitiveservices/', '/')}anthropic'

// NOTE the keys are deliberately NOT outputs. Module outputs are recorded in
// the resource group's deployment history and readable by anyone with
// deployment-read, so returning an API key here would publish it to a wider
// audience than the Key Vault it is on its way to. The keyvault module
// resolves both keys itself from these account names instead.
