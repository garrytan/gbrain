// PostgreSQL Flexible Server — the brain.
//
// SKU: Standard_B2s Burstable (2 vCore / 4 GiB). Two consequences worth
// knowing before changing it:
//
//   - Burstable does not offer the built-in PgBouncer. That is convenient
//     rather than limiting: gbrain must connect direct to 5432 anyway.
//     `isSupabasePoolerUrl` gates the dual-pool machinery and
//     prepared-statement auto-disable keys on port 6543, not Azure's 6432,
//     so behind a transaction-mode pooler `executeRawDirect` — the path
//     minion lock heartbeats and sync checkpoints depend on — silently
//     collapses onto the shared read pool. Direct 5432 also avoids the
//     startup-parameter allowlist problem, since gbrain sends
//     statement_timeout and idle_in_transaction_session_timeout as
//     connection startup parameters.
//
//   - Burstable earns CPU credits. A long HNSW index build can exhaust
//     them and slow to a crawl. The cheap fix is not to live on a bigger
//     SKU: compute scaling needs a restart but no data migration, so scale
//     up for a bulk embed and index build, then scale straight back down.
//
// Storage starts at 32 GB with autogrow on. Storage only ever grows on
// Flexible Server — there is no shrink — so starting small and letting
// autogrow react is strictly cheaper than provisioning headroom.
//
// Backup: 7 days, geo-redundancy off. Backup storage up to 100% of
// provisioned storage is included at no charge, so at 32 GB this line is $0.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Delegated subnet for VNet injection (from the network module).')
param delegatedSubnetId string

@description('Private DNS zone resource id for privatelink.postgres.database.azure.com.')
param privateDnsZoneId string

@description('Administrator login name.')
param administratorLogin string = 'gbrainadmin'

@description('Administrator password. Supply via a secure parameter or Key Vault reference; never a literal in source.')
@secure()
param administratorPassword string

@description('Compute SKU. Standard_B2s is the documented cheapest-that-works.')
param skuName string = 'Standard_B2s'

@description('SKU tier matching skuName.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'Burstable'

@description('Provisioned storage in GB. Grows but never shrinks — start small.')
param storageSizeGB int = 32

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Database name gbrain connects to.')
param databaseName string = 'gbrain'

var serverName = 'pg-${namePrefix}'

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    // VNet injection. Presence of delegatedSubnetResourceId is itself what
    // disables public network access — there is no separate flag to set,
    // and passing one alongside this is rejected.
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// pgvector. Azure gates extensions behind an allowlist server parameter;
// CREATE EXTENSION fails until the extension name appears here, so this is
// a prerequisite for gbrain's migrations, not an optimization.
//
// Deployed as a child resource so it applies before any app connects. Note
// azure.extensions is a static parameter — changing it later restarts the
// server.
resource azureExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR,PG_TRGM,UNACCENT,BTREE_GIN,PGCRYPTO'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    azureExtensions
  ]
}

output serverName string = postgres.name
output fullyQualifiedDomainName string = postgres.properties.fullyQualifiedDomainName
output databaseName string = database.name
output administratorLogin string = administratorLogin
