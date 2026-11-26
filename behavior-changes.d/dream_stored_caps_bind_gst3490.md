---
kind: fix
---
Spending caps saved with gbrain config set now bind in five dream phases that ignored them. The calibration phases (cycle.propose_takes.budget_usd, cycle.grade_takes.budget_usd, cycle.calibration_profile.budget_usd) never read a saved cap and always ran under their defaults ($5, $3 and $0.50 per run). A saved 0 for cycle.extract_atoms.budget_usd, cycle.enrich_thin.max_cost_usd or max_total_cost_usd, or cycle.conversation_facts_backfill.max_cost_usd or max_total_cost_usd was read as unset, so those phases ran under their defaults ($0.30, $1 or $5); 0 now means spend nothing. If you saved one of these caps earlier, it applies on the next dream run; check it with gbrain config get <key>.
