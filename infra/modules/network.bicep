// VNet + the two delegated subnets + the Postgres private DNS zone.
//
// Two subnets, each delegated to a different service, because neither
// service can share:
//
//   snet-aca — Container Apps infrastructure subnet. A workload-profile
//     environment requires a /27 MINIMUM; /28 is accepted for
//     consumption-only environments and rejected here. Delegation to
//     Microsoft.App/environments is mandatory.
//
//   snet-pg  — PostgreSQL Flexible Server VNet injection. Delegated to
//     Microsoft.DBforPostgreSQL/flexibleServers, and the delegation makes
//     the subnet unusable for anything else.
//
// VNet injection is used for Postgres rather than a private endpoint. It is
// the Flexible Server native private-access model, it costs nothing (a
// private endpoint carries its own hourly charge), and the outcome is the
// same for this topology: no public IP, reachable only from inside the VNet.
// The trade-off worth knowing is that it is a create-time decision — a
// server created with VNet injection cannot be moved to public access or to
// a different VNet later without a restore.

@description('Azure region for all resources.')
param location string

@description('Resource name prefix, e.g. "gbrain".')
param namePrefix string

@description('VNet address space. /24 leaves plenty of room to add subnets later.')
param vnetAddressPrefix string = '10.10.0.0/24'

@description('Container Apps infrastructure subnet. Must be /27 or larger for a workload-profile environment.')
param acaSubnetPrefix string = '10.10.0.0/27'

@description('PostgreSQL Flexible Server delegated subnet.')
param postgresSubnetPrefix string = '10.10.0.32/28'

var vnetName = 'vnet-${namePrefix}'
var acaSubnetName = 'snet-aca'
var postgresSubnetName = 'snet-pg'

// The zone name is fixed by Azure — Flexible Server will only accept this
// exact zone for its private DNS integration.
var postgresDnsZoneName = 'privatelink.postgres.database.azure.com'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: acaSubnetName
        properties: {
          addressPrefix: acaSubnetPrefix
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: postgresSubnetName
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'postgres-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: postgresDnsZoneName
  // Private DNS zones are global; 'global' is the only accepted location.
  location: 'global'
}

// Without this link the zone exists but nothing in the VNet resolves against
// it, and the container apps get a public-looking NXDOMAIN for the server
// FQDN. registrationEnabled stays false: Flexible Server writes its own
// A record, VM auto-registration is not wanted.
resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output acaSubnetId string = '${vnet.id}/subnets/${acaSubnetName}'
output postgresSubnetId string = '${vnet.id}/subnets/${postgresSubnetName}'
output postgresDnsZoneId string = postgresDnsZone.id

// Consumed only to force an ordering edge: the DNS link must exist before
// the Postgres module runs, or server creation fails resolving the zone.
output postgresDnsLinkId string = postgresDnsLink.id
