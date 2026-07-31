// The single user-assigned managed identity both container apps and the
// migration job run as.
//
// One identity rather than three because the grants are identical (pull the
// image, read the secrets) and a per-app identity would buy separation only
// if the apps needed different secrets — they do not; the worker and the MCP
// app share the same database and model credentials by design.
//
// User-assigned rather than system-assigned because the role assignments
// have to exist BEFORE the container app first starts, or the initial image
// pull fails. A system-assigned identity does not exist until its app does,
// which makes that ordering impossible to express in one deployment.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}'
  location: location
}

output id string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
output name string = identity.name
