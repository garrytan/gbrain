**Conversation pages now record which speaker is the brain's owner, when the importer can prove it.**

<!-- behavior-change: speaker_owner_marker_gst3216 -->

### Added
- Conversation pages get a `speaker_owner` frontmatter entry (`label`, `basis`, `turns`, `member`) naming the speaker label whose turns are the owner's own. It is written only from the source's own signal: a Claude Code session typed in the interactive terminal (`entrypoint: cli` on every user turn), a Codex CLI or IDE session, the owner's own ChatGPT or Claude export, an iMessage the Mac marks as sent by you (label `Me`), and a Gmail message filed as SENT (a From line alone never counts, since the sender sets it). Claude Code SDK and `claude -p` runs, worker and sub-agent sessions, headless Codex (`exec`), Hermes, Grok, OpenClaw and meeting transcripts stay speaker-unknown, and so does any page where the owner's label is not unique.
- The marker is honored only when a local importer wrote the page's current revision, its member is the member the page's source belongs to, and its shape is valid. A `speaker_owner` written by an MCP caller, or left after a remote edit of an imported page, is ignored, and a transcript re-import never carries one forward.
- Pages imported before this release keep no marker: a transcript re-import never adds one, and the conversation archive adds it only to a day it rewrites anyway. Nothing reads the marker yet; a later release uses it to file the owner's own statements on the owner's page.
