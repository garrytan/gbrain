---
kind: fix
---
An approved join_brain on an active shared-skills enrollment now renews the stored source policy, so gbrain bootstrap harness --refresh-skills clears requirements_changed after a source's skill policy changes, without a leave and re-join. When the policy did change, the join moves the enrollment epoch; a client that keeps its own copy of the epoch saves the installation_id and enrollment_epoch the join returns, since a sync with the old epoch is refused with membership_inactive. On a PostgreSQL brain, each enrollment receives one new delivery batch on its first sync after this upgrade, at the same epoch, and needs one fresh installed acknowledgment before delivery reads self_reported again.
