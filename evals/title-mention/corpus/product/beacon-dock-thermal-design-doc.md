---
title: "Beacon Dock Thermal Design Doc"
type: note
---

This document covers cooling for the four-bay Beacon dock. The enclosure is passively cooled up to 25 W total dissipation, with a single 40 mm fan enabled above 35 degrees Celsius measured at the board sensor. Fan curve: 30 percent duty at 35 C, 60 percent at 45 C, and 100 percent at 55 C. Vent slots on the rear and base are 2 mm wide to meet finger-safety rules. Chamber testing at 40 C ambient with four scanners fast-charging showed a peak bay temperature of 52 C, under the 60 C cutoff. The noise target is below 32 dBA at one meter. Thermal pads between the power stage and the aluminum plate are 1.5 mm thick. Open item: dust ingress test on the fan intake. Author: Erin Sample. Reviewer: Dan Prototype. The supply budget and charging rails are described in the companion power document.
