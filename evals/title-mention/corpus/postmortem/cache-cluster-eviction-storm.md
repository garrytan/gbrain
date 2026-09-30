---
title: "Cache Cluster Eviction Storm"
type: note
---

In August the shared cache tier suffered a wave of mass evictions after a deploy raised the default entry size for the product catalog. Memory pressure caused the nodes to evict hot keys, the hit rate dropped from 97% to 41%, and the origin database absorbed several times its normal read load. Grace Example noticed rising query latency on the catalog API and traced it to eviction counters climbing. The team rolled back the serializer change and pre-warmed keys over 25 minutes. No data was lost, but search pages were slow for about an hour. Root cause: no memory headroom alert and no load test with realistic entry sizes. Actions: alert on eviction rate, keep 30% headroom, add entry size limits to code review checks, and stagger cache restarts. Database read replicas held up, unlike during the earlier failover problem.
