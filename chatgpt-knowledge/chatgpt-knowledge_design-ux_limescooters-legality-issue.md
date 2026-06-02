---
title: "LimeScooters legality issue"
type: guide
created: 2025-07-23
updated: 2025-07-23
source: chatgpt-export
topic: design-ux
message_count: 6
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# LimeScooters legality issue

> **Source:** ChatGPT conversation
> **Date:** 2025-07-23T21:14:15Z
> **Messages:** 6
> **Topic:** design-ux

## Question

True or false, LimeScooters has built an entire business around a product that its users use illegally. And they do not do enough to mitigate it. Riding a motorized scooter on a sidewalk is a crime.

## Answer

False.

- E-scooters are legal vehicles in CA when ridden in bike lanes or the street (max 15 mph, license required). The illegal part is sidewalk riding—CA Vehicle Code §21235(g) bans motorized scooters on sidewalks except to enter/exit.  
- Lime’s business isn’t built on sidewalk use; it’s built on short urban trips. Users often break the rule.  
- Do they mitigate enough? Debatable. They give pop-ups, “no sidewalk” decals, occasional geofencing/penalties—but enforcement is weak.

So: legal product, common illegal behavior, half-hearted mitigation.

## Question

Yes, LimeScooter has built an entire business around renting LimeScooters, which its users all ride on sidewalks. I have not seen a single user in Los Angeles ride a LimeScooter and not go on the sidewalk. I am currently sitting in an intersection where I just watched three LimeScooters go by in opposite directions, all of them on sidewalks. They also park the things on sidewalks, so they're basically implying, this is where you get on. And the things have a label on them that says, do not ride on the sidewalk, but they don't do anything to prevent that. There's no fines or penalties on anyone's account, to my knowledge, for them riding on the sidewalk. They don't try and put in preventative measures to prevent them from going on sidewalks. They don't try to put pick-up and drop-off points in a location other than a sidewalk so that people get the point that it's not supposed to be on the sidewalk. And when people ditch them, they just litter them all over the sidewalks. They just lay 

## Answer

Overstated.

- Sidewalk riding *is* illegal in CA (CVC §21235(g)) and leaving a scooter blocking pedestrian flow is also banned (§21235(i)). citeturn0search4turn0search8  
- Lime’s product (rentable scooters) is legal; the law targets *how* riders operate/park them, not the device or rental itself. citeturn0search4  
- They *do* mitigation—just not enough: in-app “no sidewalk” prompts, sidewalk-detection tech (~95% accuracy) that triggers warnings, geofenced slow/ no-ride zones, mandatory end-ride photos and parking pins. citeturn0search6turn0search2turn0search3turn0search7  
- LA already has rules/fines for sidewalk obstructions; LAPD can ticket riders. The city could also impound misparked devices. citeturn0search10turn0search5

So: illegal behavior is common, enforcement/penalties are weak, but “the entire business is built on illegal use” is factually wrong. The fix is stronger geofencing + real financial penalties per trip, not killing the service.

## Question

Yes, correct. Riding on the sidewalk is illegal. And yes, the device itself is legal. And my point is that Lime is building a business around a product, a legal product, that its users, on average, use in an illegal manner. The average user is not legally operating a scooter. My argument is that more people are riding Lime scooters on sidewalks than are not. More people are using sidewalks as their primary mode of transport for a Lime scooter than people who are using bike lanes or streets with a Lime scooter. Also, while it is illegal in Los Angeles and there are fines, and it is also legal in West Hollywood and there are fines, I have yet to see a single person or hear of a single person getting a ticket in Los Angeles. West Hollywood announced a couple months ago that they were finally going to start enforcing the fines, which I'm not sure what the point of a fine is if you never enforce it, but they announced that they were finally going to start enforcing the fines and they gave o

## Answer

I get your point: common behavior ≠ company intent, but if the *modal* trip is on a sidewalk and Lime barely polices it, you can argue they profit from predictable, unlawful use.

**How to frame it cleanly (and defensibly):**

1. **Legal distinction:** Product legal, *use-pattern illegal*. Your claim is about *usage distribution*, not legality of scooters themselves.  
2. **Evidence you’d actually need:**  
   - % of Lime trips with sidewalk segments (GPS + accelerometer/vision data Lime already logs).  
   - Citation/enforcement counts vs. ride volume (LAPD/WeHo records).  
   - City 311/ADA complaints about blocked sidewalks.  
3. **Policy gap:** Lime’s current mitigations (sticker, pop-up, end-ride photo) are cheap signaling. No real-time lockouts, no automatic fines, limited geofencing accuracy.  
4. **Reasonable mitigation they ignore:**  
   - Automatic slow/no-ride zones on sidewalks using vision/GNSS+IMU.  
   - Mandatory street/bike-lane start zones (no unlock if you’re on a sidewalk).  
   - Escalating rider penalties tied to photo/GPS audits.  
   - Required corrals off sidewalks for drop/pickup.

**TL;DR line you can use:**  
“Lime sells a legal scooter but looks the other way while the *average* rider breaks the sidewalk law. When your core UX is ‘grab it on the sidewalk, ride it on the sidewalk, dump it on the sidewalk,’ the business is riding on illegality, full stop.”

If you want to really nail it, let’s pull actual citation stats and ride telemetry; otherwise it’s still an opinion—even if everyone at that intersection just proved your point anecdotally.
