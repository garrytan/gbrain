# Phase 11: Personal Data Connectors

Date: 2026-05-20
Status: Detailed phase spec
Depends on: Phase 01, Phase 02, Phase 06

## Goal

Implement the connector framework for personal data sources. MBrain should be
designed for broad source support from the beginning, while allowing users to
choose which sources participate in memory.

## Design Decisions

- Personal data hub scope includes all target source types.
- Users grant minimal consent per source.
- Connectors inherit source policy.
- Credentials use an external broker/gateway first, then keychain/password
  manager fallbacks.
- Connector output is source items and chunks, not direct canonical writes.

## In Scope

- connector registry.
- connector capability model.
- credential reference model.
- source sync protocol.
- incremental cursor support.
- source item mapping.
- connector health checks.
- connector pause/revoke behavior.
- initial connector implementations or stubs for all source classes.

## Out Of Scope

- Full web OAuth admin UI.
- Remote multi-user OAuth server.
- Direct credential exposure to agents/runners.
- Connector-specific advanced UX.

## Connector Classes

Target classes:

- agent/session import
- filesystem/Markdown/documents
- PDF/document import
- meeting transcripts
- code repositories
- email
- calendar
- browser/bookmarks/history
- chat exports
- Slack/Discord
- generic archive import

Implementation can phase actual connectors, but registry and policy model must
support all classes.

## Credential Model

Credential priority:

1. credential gateway/broker
2. OS keychain
3. password manager integration
4. local encrypted vault fallback

Tables:

- `credential_refs`
- `connector_accounts`
- `connector_grants`
- `connector_sync_states`

MBrain DB stores:

- credential reference
- provider
- granted scopes
- expiry
- last used
- rotation status
- health status

It must not store raw credential secrets.

## Sync Protocol

Connector sync produces:

- source items
- source chunks
- metadata
- content hashes
- source timestamps
- deletion/archive signals
- cursor updates
- sync events

Sync must be idempotent.

## Safety

- Connector credentials are never available to runner tools.
- Source revocation stops sync and raw access.
- Prompt injection and secret scanning still happen after connector ingest.
- Connector failures are reported but do not corrupt source registry.
- Deletion from source maps to retention/archive policy, not immediate silent
  purge unless policy requires it.

## Tests

Required tests:

- connector registers source and policy
- credential reference is stored without secret
- sync is idempotent by external id and content hash
- revoked source prevents sync
- connector item becomes source item/chunks
- connector failure records health event
- source deletion maps to retention policy

## Acceptance Criteria

- MBrain can support all planned personal source classes through one connector
  framework.
- Users can choose sources with minimal consent.
- Connector data flows into raw ingest, not direct canonical mutation.
