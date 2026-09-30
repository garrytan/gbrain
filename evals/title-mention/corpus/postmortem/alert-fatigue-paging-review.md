---
title: "Alert Fatigue Paging Review"
type: note
---

Over the third quarter the on-call rotation received an average of 46 pages per week, and only 18% needed human action. Karen Example analyzed pager data and found that three noisy rules, including the disk usage warning and the cache hit-rate flap, produced more than half of all pages. Engineers reported nearly missing real alerts during the certificate and cache problems because they had started muting notifications at night. Recommendations: convert informational alerts to tickets, require a runbook link on every paging rule, add a five-minute delay for flapping metrics, and review page counts monthly. The team set a goal of under 15 pages per week with at least 60% actionable. Follow-up progress will be reported in weekly updates and reviewed at the next quarterly incident forum.
