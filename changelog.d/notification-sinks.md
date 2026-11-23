**Take proposals reach Slack, with Accept / Reject buttons that decide them.**

<!-- behavior-change: notification_sinks -->

### Added
- Outbound notification sinks (`gbrain config set notify.sinks '<json>'` or `GBRAIN_NOTIFY_SINKS`): `take_proposal.created`, `.accepted` and `.rejected` events queue in a durable outbox (one row per sink, event and proposal, retried with backoff) that `gbrain serve --http` delivers. Filters by weight, kind, page prefix, holder and source. Queueing never fails or slows the dream cycle or a decision.
- The `slack` sink (reusing the Slack connector's bot token) posts one message per proposal and edits it when the proposal is decided through Slack, MCP or the CLI. Its Accept / Reject buttons post to `POST /integrations/slack/interactions`, verified with the app's signing secret; the clicker must be a channel member (or in `allowed_users`), and their email is recorded as the reviewer. The `webhook` sink POSTs JSON signed with HMAC-SHA256. New sink types register with `registerSinkType`.
- `gbrain notify-status`, `notify-backfill` (queue already-pending proposals, highest weight first, with a limit), `notify-drain` and `notify-retry`. Guide: `docs/integrations/notification-sinks.md`.
