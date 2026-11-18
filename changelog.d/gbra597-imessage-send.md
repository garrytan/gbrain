**GBrain Helper on a Mac can now send a one-to-one iMessage for the owner's agent; upgrading gbrain installs nothing on the Mac, and sending stays off until the owner turns it on at the Mac with Touch ID.**

### Added
- `POST /v1/imessage/send` on the helper's tailnet listener sends one iMessage to one phone number or email address. Each request is signed with an Ed25519 send key, carries an `Idempotency-Key`, and only addresses listed in `listen.tailnet.allowed_peers` may call it. The answer says `sent`, `unknown` (Messages took it but didn't confirm in time) or a refusal, with `retryable` and `side_effects`, so an agent knows whether a retry could send twice. A retry with the same key never sends again.
- Sending is off until the owner runs `gbrain-apple-helper send-setup` at the Mac and confirms with Touch ID. Adding a send key (`send-key add`) and raising a limit (`send-limits set`) also need Touch ID. `send-setup --off` or `send.enabled: false` in the config stops the next send without a restart, and once the helper has seen it off, turning sending on again needs Touch ID.
- Limits on by default: 5 texts a minute, 30 an hour and 60 a day, 10 an hour to one recipient, and 3 a day to people never texted one-to-one before. A banner shows on the Mac for every send.
- Every attempt and outcome goes to a send log on the Mac (mode 0600). After 90 days each line keeps only its time, outcome, code and a short hash of the recipient. `gbrain-apple-helper send-audit show --redacted` prints the redacted form.
- `src/core/apple/send-sign.ts` signs send requests the way the helper checks them, tested against shared vectors.

