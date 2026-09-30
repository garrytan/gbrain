---
title: "Falcon Sensor Hub Spec v2"
type: note
---

This revision replaces the earlier hub specification and raises capacity to 32 wireless sensors. Sampling rate is now configurable from one reading per 5 seconds to one per 300 seconds, with a default of 30 seconds. Local buffering extends to 96 hours using 8 MB of external flash. The sub-gigahertz radio gains per-device AES-128 keys, replacing the shared key used in v1. Firmware updates can now be delivered over Ethernet or wirelessly, using signed images and automatic rollback if the new image fails to boot. The microcontroller is unchanged, but RAM grows to 256 KB. Enclosure dimensions become 90 by 90 by 28 millimeters to fit the added antenna. The backup coin cell is retained. Battery-free sensors remain out of scope. Owner: Alice Example. Reviewers: Bob Sample and Carol Placeholder. Target pilot build: second quarter, in the Harbor Street lab, with the same sensor family as the first release.
