// ca-gbrain-mcp — the public MCP surface. `gbrain serve --http`.
//
// Scale-to-zero (minReplicas 0). Safe because a Bun single-binary cold start
// plus a Postgres connect lands well inside Claude Code's 60-second
// first-byte timer; the client config still sets a 120s per-server timeout
// for headroom.
//
// maxReplicas is 2 only so a revision swap can overlap. The app CANNOT
// usefully scale past a small replica count: admin sessions, magic-link
// nonces and every express-rate-limit bucket are in-process Maps, so extra
// replicas mean per-replica rate limits and session affinity problems.
// Treat 2 as a deployment mechanism, not capacity.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Container Apps environment resource id.')
param environmentId string

@description('User-assigned identity resource id (ACR pull + Key Vault read).')
param identityId string

@description('Registry login server, e.g. myacr.azurecr.io.')
param registryLoginServer string

@description('Fully qualified image reference.')
param image string

@description('Secrets to expose, as [{ name, keyVaultUrl }].')
param secretRefs array

@description('Environment variables shared by both apps.')
param sharedEnv array

@description('Public URL clients reach this app at. Used as the OAuth issuer.')
param publicUrl string

@description('Container CPU cores.')
param cpu string = '0.5'

@description('Container memory. Must pair with cpu per the Consumption profile ratios.')
param memory string = '1Gi'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${namePrefix}-mcp'
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
      ingress: {
        external: true
        targetPort: 8787
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
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
          name: 'gbrain-mcp'
          image: image
          command: ['gbrain']
          args: ['serve', '--http', '--port', '8787', '--bind', '0.0.0.0', '--public-url', publicUrl]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(sharedEnv, [
            {
              name: 'GBRAIN_PUBLIC_URL'
              value: publicUrl
            }
            {
              // Container Apps fronts every request with envoy, so without
              // this Express's default 'loopback' trust collapses every
              // rate-limit bucket onto the proxy's IP — one shared bucket
              // for all clients. Safe here specifically because envoy
              // rewrites X-Forwarded-For rather than appending to a
              // client-supplied one.
              name: 'GBRAIN_HTTP_TRUST_PROXY'
              value: '1'
            }
            {
              // No admin web plane on the public port. See §9.2 of the plan
              // and the guard in serve-http.ts: /admin cannot be firewalled
              // separately from /mcp, so it is disabled outright and
              // administration happens over `az containerapp exec`.
              name: 'GBRAIN_DISABLE_ADMIN'
              value: '1'
            }
            {
              name: 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN'
              secretRef: 'gbrain-admin-bootstrap-token'
            }
          ])
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8787
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8787
              }
              // Generous: /health probes the database, and a Postgres that
              // is still starting (the scheduled-operation morning window)
              // must not get the container killed underneath it.
              initialDelaySeconds: 20
              periodSeconds: 30
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

output name string = app.name
output fqdn string = app.properties.configuration.ingress.fqdn
