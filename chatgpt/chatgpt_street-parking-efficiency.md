---
title: "Street Parking Efficiency"
type: note
created: 2025-06-22
updated: 2025-06-22
source: chatgpt-export
conversation_id: 6857b84e-7b84-8007-8d31-10ccaadcd6b7
message_count: 2
tags: [chatgpt, import]
---
# Street Parking Efficiency

> Conversation ID: 6857b84e-7b84-8007-8d31-10ccaadcd6b7
> Created: 2025-06-22T08:01:18Z
> Updated: 2025-06-22T08:02:44Z
> Messages: 2

---

## User

What, statistically, is the most efficient way to do street parking? Is it cars being parked the normal way, where you have to parallel park? Is it lines sticking out on angles? Is it lines sticking out on straight lines? Is it where you have predetermined parking spots, where you have to parallel park into them? Or is it where there's no lines and people freely park? Even though that means that they can have constantly adjusting parking space size due to different vehicle sizes and people parking close together or not close together. But I suppose if you have predetermined lines, then you don't get to take advantage of shorter cars and stuff like that. What's the most efficient way to do it?

---

## Assistant

**How “efficient” do you want to be?**

| curb-side layout (same block length) | spaces per ~100 ft of curb | extra street width needed | crash record | notes |
|---|---|---|---|---|
| **Parallel, marked bays (≈ 22 ft each)** | ≈ 4.5 | none | baseline | easy to enforce & meter |
| **Parallel, *un-striped*** | ≈ 4.7 – 4.8 (≈ +5 %) | none | same as above | real-world counts in Virginia gained **1 extra car for every 8** spots  citeturn6view0 |
| **Parallel, “hit-the-line” (paint one stripe every ~2× avg-car length, ~30 ft)** | up to ≈ 5.1 (+14 % if drivers comply) | none | same | simulation study  citeturn10view0 |
| **45° angle** | ≈ 8 | +7–9 ft (one-way aisle) | 50-70 % more crashes than parallel if nose-in  citeturn11view0 | easiest angle to enter; works only with one-way traffic |
| **60° angle** | ≈ 10 | +9–10 ft | same safety caveats | common compromise (needs one-way lane ≈ 20 ft wide)  citeturn13view0 |
| **90° (perpendicular)** | ≈ 12 | +18 ft (full lane) | worst sight-lines when backing | really a parking-lot treatment, not for busy streets |

### Key take-aways

1. **If you cannot steal extra roadway width, stay parallel and *don’t* stripe individual bays.**  
   In heavy-demand blocks, letting drivers “self-pack” yields about **5 % more cars** than 22-ft bays because the random mix of Minis and Suburbans fills micro-gaps more efficiently. citeturn6view0  

2. **Striping can still pay off for management reasons.**  
   Lines make metering, ADA stalls, and turnover enforcement simpler, at the cost of that 1 car-in-8 capacity hit. Kittelson’s 2024 survey notes many cities accept the trade-off downtown but leave residential streets unmarked. citeturn2view0  

3. **A smart compromise is the “block-mark” concept.**  
   Painting a stripe every ~30 ft (≈ two average cars) gives drivers a visual cue yet preserves most of the packing benefit—modeling showed an **≈ 14 % gain** over standard stalls when compliance is high. citeturn10view0  

4. **Need *maximum* cars and have pavement to spare? Go reverse 60° angle.**  
   Along the same 100 ft of curb you squeeze about **double** the cars (≈ 10 vs 4–5) but you must convert a full lane to parking and make the street one-way. Safety studies found traditional nose-in angle parking raises crash rates 50-70 % relative to parallel; back-in (reverse) angle largely fixes the visibility problem but still needs width. citeturn11view0  

5. **Perpendicular curb parking wins the pure-count contest but is rarely worth the trade-offs.**  
   It grabs an entire travel lane (≈ 18 ft), forces very slow speeds, and leaves drivers blind when backing out.

---

### Bottom line for “statistical” efficiency

* **Narrow street (keep all lanes):** un-striped parallel (or long block marks) is the densest practical choice.  
* **Wide right-of-way you can re-stripe:** reverse 60° angle packs the most cars per linear foot while keeping maneuvering reasonable.  
* **Heavy traffic corridor:** stick with parallel—even a few extra spaces aren’t worth the crash risk and flow disruption of angle parking.

Everything else—striping, meters, sensors—should be layered on only if the operational benefits outweigh the ~5 % capacity you give up.
