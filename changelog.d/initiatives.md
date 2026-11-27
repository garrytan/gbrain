**Ideas and initiatives: propose, run with a Slack channel, finish, and merge into project pages.**

<!-- behavior-change: initiatives_lifecycle -->

### Added
- Schema pack `gbrain-initiatives` (extends gbrain-base-v2): page types `idea` (never a fact source or target) and `initiative` (a fact target), link types `implements`, `targets`, `created_by`, `similar_to`. Page types can declare `fact_target: true`.
- Operations `idea_submit`, `initiatives_list`, `initiative_status`, `initiative_start`, `initiative_bind_slack`, `finish_initiative`, `initiative_merge_apply`.
- Slack sources: `--channels-from initiatives` reads every channel bound to an active initiative and routes their facts onto the initiative; `--mode intake` turns a channel's messages into ideas with a thread reply listing similar ideas, initiatives and pages.
- Job `initiative_finish`: final Slack sync, closing message, leaving the channels, and (done) a merge plan written into the initiative page.
- Dream-cycle phase `ideas`: idea status from the initiatives implementing them, similar-idea links, thread replies on Slack-born ideas.
- Config prefix `initiatives.*`; guide `docs/guides/initiatives.md`.
