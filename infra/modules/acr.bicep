// Container registry for the gbrain image.
//
// Basic SKU. It caps at 10 GiB and has no geo-replication, both irrelevant
// for a single compiled binary in a slim base image.
//
// adminUserEnabled stays FALSE. The admin user is a shared username/password
// that cannot be scoped or attributed, and enabling it would undo the point
// of granting AcrPull to the managed identity. Pulls authenticate as the
// UAMI; pushes authenticate as the GitHub Actions federated credential.

@description('Azure region.')
param location string

@description('Resource name prefix.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Principal id granted AcrPull.')
param pullPrincipalId string

// Registry names are globally unique and alphanumeric only — no dashes, so
// namePrefix is stripped of them. uniqueString is always 13 characters and
// namePrefix is capped at 12 upstream, so this lands between 16 and 28 —
// comfortably inside the 5-50 limit without a take() that could silently
// truncate a longer prefix into a collision.
var registryName = toLower('acr${replace(namePrefix, '-', '')}${uniqueString(resourceGroup().id)}')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// Built-in "AcrPull".
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pullPrincipalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer

// Ordering handle: a container app that starts before this propagates
// fails its first image pull with an authentication error.
output roleAssignmentId string = acrPullAssignment.id
