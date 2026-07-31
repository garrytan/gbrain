// Container Apps managed environment.
//
// Workload-profile type with only the Consumption profile defined. That
// combination bills identically to a consumption-only environment — the
// Consumption profile inside a workload-profile environment is the same
// meter — while keeping the door open for a Dedicated profile later.
//
// Why that matters here: raising the ingress idle timeout above the default
// 4 minutes requires Premium ingress, which requires a Dedicated D4-D32
// profile. A consumption-only environment cannot be converted; it would be a
// rebuild. The 4-minute timeout is not a problem for gbrain today (its MCP
// transport is stateless and GET /mcp returns 405, so there is no
// long-lived server-to-client stream to time out), but the constraint it
// imposes is real: any operation that could exceed 4 minutes must be a
// minion job rather than a synchronous MCP tool call.
//
// zoneRedundant stays off — it requires a larger subnet and only pays off
// with multiple replicas, which this single-replica design does not have.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Infrastructure subnet id, delegated to Microsoft.App/environments and /27 or larger.')
param infrastructureSubnetId string

@description('Log Analytics workspace resource id for container stdout/stderr.')
param logAnalyticsWorkspaceId string

@description('Log Analytics workspace customer (GUID) id.')
param logAnalyticsCustomerId string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logAnalyticsWorkspaceId, '/'))
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      // false = the environment gets a public ingress IP. The MCP app needs
      // one; the worker has ingress disabled entirely, so it is unreachable
      // regardless. Setting this true would make the whole environment
      // internal and require a VPN or Bastion to reach the brain.
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

output environmentId string = environment.id
output defaultDomain string = environment.properties.defaultDomain
output staticIp string = environment.properties.staticIp
