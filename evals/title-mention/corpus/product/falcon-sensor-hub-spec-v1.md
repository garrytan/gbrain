---
title: "Falcon Sensor Hub Spec v1"
type: note
---

This specification defines the first production release of the Falcon hub, a wall-mounted unit that aggregates temperature, humidity, and motion readings from up to 16 wireless sensors. The hub uses a dual-core microcontroller with 512 KB of flash and 128 KB of RAM. Sampling rate is fixed at one reading per 60 seconds per sensor, and data is buffered locally for up to 48 hours during network outages. The radio is sub-gigahertz with a rated indoor range of 40 meters. Power comes from a 5 V adapter, with a coin-cell backup that keeps the clock alive for 30 days. The enclosure is white polycarbonate, 90 by 90 by 25 millimeters. Firmware updates are delivered over Ethernet only. Known limitations: no encryption of the sensor link beyond a single shared key, and no support for battery-free sensors. Owner: Alice Example. Reviewers: Bob Sample and Carol Placeholder. Approved for the pilot build in the Harbor Street lab.
