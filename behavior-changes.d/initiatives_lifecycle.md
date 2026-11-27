---
kind: add
---
Ideas and initiatives: a new bundled schema pack, gbrain-initiatives, adds the idea and initiative page types; page types can declare fact_target: true so facts may attach to them. Seven operations (idea_submit, initiatives_list, initiative_status, initiative_start, initiative_bind_slack, finish_initiative, initiative_merge_apply) run the lifecycle; Slack sources gain --channels-from initiatives (facts from bound channels land on the initiative) and --mode intake (each message becomes an idea); the initiative_finish job leaves the channels and proposes a merge of the initiative's facts into its target pages; the ideas dream-cycle phase updates idea status and links similar ideas. Nothing changes for brains that do not activate the pack or create such sources.
