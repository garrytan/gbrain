// caj-gbrain-migrate — schema migrations, as a manually-triggered job.
//
// A separate job rather than an init step inside the serving apps, for two
// reasons that both bite on Azure specifically:
//
//   1. initSchema holds pg_advisory_lock(42) for the entire migration
//      replay. If every replica ran it on boot, replica 2 would block on
//      replica 1 for the whole replay and fail its readiness probe.
//
//   2. `CREATE INDEX CONCURRENTLY` runs under the standard 5-minute
//      statement_timeout on Azure. gbrain's 30-minute DDL pool only
//      activates for Supabase-shaped URLs, so this job raises
//      GBRAIN_STATEMENT_TIMEOUT itself.
//
// Run it to completion BEFORE promoting a serving revision that expects the
// new schema.
//
// Sized larger than the serving apps (1 vCPU / 2 GiB): index builds are the
// heaviest thing this deployment ever does, and the job is billed only while
// it runs.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Container Apps environment resource id.')
param environmentId string

@description('User-assigned identity resource id.')
param identityId string

@description('Registry login server.')
param registryLoginServer string

@description('Fully qualified image reference.')
param image string

@description('Secrets to expose, as [{ name, keyVaultUrl }].')
param secretRefs array

@description('Environment variables shared with the apps.')
param sharedEnv array

@description('Per-execution wall clock cap, seconds. An HNSW build on a Burstable SKU that has exhausted its CPU credits is slow, so this is deliberately generous.')
param replicaTimeoutSeconds int = 3600

@description('Statement timeout for the migration session, ms. Must exceed the longest CREATE INDEX CONCURRENTLY; Azure defaults to 5 minutes.')
param statementTimeoutMs string = '1800000'

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: 'caj-${namePrefix}-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeoutSeconds
      // No retries. A half-applied migration must be inspected, not
      // reattempted blindly — the second attempt would race the advisory
      // lock the first one may still hold.
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
      secrets: [
        for s in secretRefs: {
          name: s.name
          keyVaultUrl: s.keyVaultUrl
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'gbrain-migrate'
          image: image
          command: ['gbrain']
          args: ['apply-migrations', '--yes', '--non-interactive']
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: concat(sharedEnv, [
            {
              name: 'GBRAIN_STATEMENT_TIMEOUT'
              value: statementTimeoutMs
            }
          ])
        }
      ]
    }
  }
}

output name string = job.name
