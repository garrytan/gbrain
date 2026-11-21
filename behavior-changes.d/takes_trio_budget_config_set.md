---
kind: fix
---
The per-run spending caps cycle.propose_takes.budget_usd, cycle.grade_takes.budget_usd and cycle.calibration_profile.budget_usd now take effect when set with gbrain config set. Before, those three dream phases ignored a cap stored that way and always used their defaults ($5, $3 and $0.50 per run). If you set one of these caps earlier, it now binds on the next dream run; check it with gbrain config get.
