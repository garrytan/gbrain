---
kind: fix
---
An approved join_brain on an active shared-skills enrollment now renews the stored source policy when the source's skill policy only moved its epoch, so gbrain bootstrap harness --refresh-skills clears requirements_changed without a leave and re-join. The join moves the enrollment epoch when it renews anything; a client that keeps its own copy of the epoch saves the installation_id and enrollment_epoch the join returns, since a sync with the old epoch is refused with membership_inactive. A policy that now asks for a tool the enrollment never approved, a new source and a recreated source are not renewed and stay requirements_changed until the owner approves a new enrollment.
