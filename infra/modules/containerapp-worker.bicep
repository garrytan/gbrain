// ca-gbrain-worker — the minion supervisor. `gbrain jobs supervisor`.
//
// No ingress at all. Not "internal ingress" — disabled: the supervisor
// listens on nothing and exposing a port would only create surface.
//
// minReplicas == maxReplicas == 1, and that is a correctness constraint, not
// a cost choice. Two supervisors would race on the same job leases; the lock
// machinery would survive it, but the result is duplicated LLM spend on
// every cycle phase.
//
// Scaling this app to 0 outside operating hours is the scheduled-operation
// lever (scripts/azure/stop.sh). The supervisor handles SIGTERM gracefully,
// waiting up to ~40s for its child worker to finish the job in flight, so a
// scale-to-zero is a clean stop rather than an interruption.

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

@description('Environment variables shared by both apps.')
param sharedEnv array

@description('Replica count. 0 stops the worker for the scheduled off-hours window; 1 is running. Never above 1 — two supervisors race on job leases.')
@minValue(0)
@maxValue(1)
param replicas int = 1

@description('Container CPU cores.')
param cpu string = '0.5'

@description('Container memory.')
param memory string = '1Gi'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${namePrefix}-worker'
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
      activeRevisionsMode: 'Single'
      // No `ingress` key at all — omitting it is what disables ingress.
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
          name: 'gbrain-worker'
          image: image
          command: ['gbrain']
          args: ['jobs', 'supervisor']
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(sharedEnv, [
            {
              // Pinned to an absolute path rather than inferred. gbrain
              // resolves its home three different ways that disagree —
              // config.ts appends `.gbrain` to GBRAIN_HOME,
              // brain-repo-durability.ts does not, and the supervisor
              // ignores GBRAIN_HOME entirely in favour of $HOME/.gbrain —
              // so an inferred PID path is a coin flip.
              name: 'GBRAIN_SUPERVISOR_PID_FILE'
              value: '/data/.gbrain/supervisor.pid'
            }
          ])
        }
      ]
      scale: {
        minReplicas: replicas
        maxReplicas: replicas
      }
    }
  }
}

output name string = app.name
