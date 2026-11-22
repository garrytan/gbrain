**Bundled skills now tell you when a model refuses instead of hiding it, ask for the narrowest access that works, and `gbrain book-mirror` no longer writes a refused chapter into the page as finished.**

### Fixed
- `gbrain book-mirror` marks a chapter the provider refused, or whose output filter stopped it, as failed with "provider refusal or output filter stop". Before, the refusal text went into the page as a completed chapter and the run could exit 0. The retry hints now say to retry only if you choose, and that a refused chapter's job has to be deleted first (`gbrain jobs delete <id>`).

### Changed
- The cross-modal-review skill reports a review model's refusal to you as a provider refusal. Another model reviews only when you pick one, or when `refusal_routing.behavior` in `skills/conventions/cross-modal.yaml` is `next_in_chain`, and the output then names the switch. The default is `report`. `skills/conventions/model-routing.md` follows the same rule.
- The cold-start skill, the credential-gateway recipe and its integration doc ask for the narrowest gateway task scope and purpose that does the job. When a request you need is blocked, the agent tells you and widens the task with your agreement.
- The book-mirror skill records a filter-stopped chapter as that chapter's result and tells you, and retries only if you choose.
