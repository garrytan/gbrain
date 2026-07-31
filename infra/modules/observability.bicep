// Log Analytics workspace.
//
// This is a REQUIRED resource, not an optional nice-to-have. The container
// filesystem is ephemeral, so gbrain's audit JSONL under GBRAIN_AUDIT_DIR is
// destroyed on every restart and every revision swap. Log Analytics is the
// only durable audit sink in this deployment.
//
// 30-day retention: the first 31 days are included at no extra charge on the
// PerGB2018 tier, so this is the longest free retention. Raise it only with
// the cost in mind.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Retention in days. 30 is the longest span included at no extra charge.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      // Log Analytics defaults to allowing ingestion over the public
      // endpoint; the container apps have no other path to it, and the
      // alternative (Private Link Scope) is a separate billable resource.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output workspaceId string = workspace.id
output customerId string = workspace.properties.customerId
output name string = workspace.name
