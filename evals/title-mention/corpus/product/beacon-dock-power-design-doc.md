---
title: "Beacon Dock Power Design Doc"
type: note
---

The Beacon dock charges four handheld scanners at once from a single 65 W supply. Each bay has a dedicated charging rail rated at 12 W, with current limiting and a thermal cutoff at 60 degrees Celsius. Input is 100-240 V AC through a detachable cord. A power-path controller shares the budget: when all four bays are charging, each receives 12 W, and idle bays release budget to the others up to 20 W per bay. The efficiency target is 88 percent at full load, with standby draw under 0.3 W. Known issue: rail three shows a voltage sag of 0.4 V when a fast-charge scanner is docked alongside three others; this is tracked for the next board revision. Electrical design by Dan Prototype, reviewed by Erin Sample. Fan curves and enclosure venting are handled in a separate companion document.
