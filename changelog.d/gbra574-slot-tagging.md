**Conversation facts get slots again, from a second small call that leaves extraction's own output unchanged.**

### Added
- `gbrain extract-conversation-facts` tags where a person lives, who employs them or their role on the facts it extracts, so the facts block can show when a value held ("valid FROM to UNTIL"). The tags come from a second, small call after extraction, which reads only the facts about a person whose page the extractor named exactly (at most 10 per conversation window); the extraction call stays the one that saves every wish, preference and idea. A brain whose conversation facts name no person page makes no extra call. The call counts toward the run's cost cap, the per-page cap and the `--dry-run` estimate. A window whose tagging call fails keeps its facts without slots, the summary counts it, and `--force` tags it again.

<!-- behavior-change: conversation_slot_tagging_gbra574 -->
