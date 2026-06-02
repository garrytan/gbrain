---
conversation_id: 68ed5d5a-2920-8328-9dcb-b3524cd1f4da
created: 2025-10-13
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 14
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Sales analysis summary
type: note
updated: 2025-10-15
---

# Sales analysis summary

**Related:** [[business_startup]]

> Conversation ID: 68ed5d5a-2920-8328-9dcb-b3524cd1f4da
> Created: 2025-10-13T20:13:31Z
> Updated: 2025-10-15T23:43:58Z
> Messages: 14

---

## User

Item Name	Sales Category	Quantity Sold
Black Magic	Specialty Cocktails	81
Wicked Watermelon	Specialty Cocktails	69
Beetle Juice	Specialty Cocktails	65
Main Bar Test Print	Specialty Cocktails	56
Old Hollywood	Specialty Cocktails	53
Laughing Gas	Specialty Cocktails	33
Scream-tini	Specialty Cocktails	21
Titos	Mixed Drinks	18
Casamigos (Blanco)	Mixed Drinks	10
SHOT: Scooby Snacks	Specialty Cocktails	9





---

## Assistant

Mr. White — here’s a quick read on the sales you shared:

- **Total units:** 415  
- **Category mix:** Specialty Cocktails **387 (93.3%)** | Mixed Drinks **28 (6.7%)**  
- **Concentration:** Top 3 SKUs = **51.8%** of all sales; Top 5 = **78.1%**  
- **Avg per SKU:** Specialty **48.4** vs Mixed **14.0**  
- **Spread:** Best vs worst seller = **81 vs 9** (9×)

**SKU ranking (units):**  
1) Black Magic 81  
2) Wicked Watermelon 69  
3) Beetle Juice 65  
4) Main Bar Test Print 56  
5) Old Hollywood 53  
6) Laughing Gas 33  
7) Scream-tini 21  
8) Titos 18  
9) Casamigos (Blanco) 10  
10) SHOT: Scooby Snacks 9

If you want, I can turn this into a quick chart or a reorder/86 list based on your par levels.

---

## User

Show me just specialty cocktails
Knowing that each drink is poured over a full cup of ice how many liters of each did we burn through.

---

## Assistant

Mr. White — here are **Specialty Cocktails only**, assuming **~8 fl oz liquid per drink** (ice excluded; 1 oz = 0.0295735 L).

| Item | Qty | Liters (8 oz pour) |
|---|---:|---:|
| Black Magic | 81 | **19.2 L** |
| Wicked Watermelon | 69 | **16.3 L** |
| Beetle Juice | 65 | **15.4 L** |
| Main Bar Test Print | 56 | **13.2 L** |
| Old Hollywood | 53 | **12.5 L** |
| Laughing Gas | 33 | **7.8 L** |
| Scream-tini | 21 | **5.0 L** |
| SHOT: Scooby Snacks | 9 | **2.1 L** |
| **Total** | **387** | **91.6 L** |

**Adjust if your build differs:** scale linearly.  
- 6 oz → multiply by **0.75** (total ≈ **68.7 L**)  
- 10 oz → multiply by **1.25** (total ≈ **114.4 L**)  
- 12 oz → multiply by **1.50** (total ≈ **137.3 L**)

If you want this broken down by base spirit or to a keg/handle count, say the word.

---

## User

We did this over 3 days with 175/200/80 guests per day.

Figure out our average volume poured of each drink per guest so i can estimate based on next weeks sales

---

## Assistant

Mr. White — per **guest** averages for **Specialty Cocktails** (assumes **8 fl oz** liquid per drink; ice excluded):

| Drink | Drinks/Guest | Liters/Guest | mL/Guest |
|---|---:|---:|---:|
| Black Magic | 0.178 | 0.042 | 42 |
| Wicked Watermelon | 0.152 | 0.036 | 36 |
| Beetle Juice | 0.143 | 0.034 | 34 |
| Main Bar Test Print | 0.123 | 0.029 | 29 |
| Old Hollywood | 0.116 | 0.028 | 28 |
| Laughing Gas | 0.073 | 0.017 | 17 |
| Scream-tini | 0.046 | 0.011 | 11 |
| SHOT: Scooby Snacks | 0.020 | 0.005 | 5 |

**How to use:**  
- For a headcount **G**, projected liters of a drink = **(Liters/Guest × G)**.  
- If you prefer **6/10/12 oz** builds, scale all liters by **0.75 / 1.25 / 1.50** respectively.  
- If “Scooby Snacks” is a 2 oz shot, multiply its values by **0.25**.

---

## User

{'asset_pointer': 'sediment://file_000000001db061f79f3c52b90813d0c8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 563, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 605274, 'width': 1202}
Here's the numbers for the coming week. Assume all sales double by show time. Predict how much of each we need

---

## Assistant

Mr. White — using the per-guest rates we derived (8 oz liquid per drink, ice excluded) and doubling current pre-sales:

**Expected guests:** 132, 144, 94, 140, 128, 160 → **798 total**

### Prep needed (week total)
| Drink | L/Guest | Week Liters | ~Drinks to Prep (8 oz) |
|---|---:|---:|---:|
| Black Magic | 0.042 | **33.5 L** | 142 |
| Wicked Watermelon | 0.036 | **28.7 L** | 121 |
| Beetle Juice | 0.034 | **27.1 L** | 114 |
| Main Bar Test Print | 0.029 | **23.1 L** | 98 |
| Old Hollywood | 0.028 | **22.3 L** | 93 |
| Laughing Gas | 0.017 | **13.6 L** | 58 |
| Scream-tini | 0.011 | **8.8 L** | 37 |
| SHOT: Scooby Snacks | 0.005 | **4.0 L** *(**1.0 L** if it’s a 2 oz shot)* | 16 |

**Notes**
- Scale for different builds: multiply liters by **0.75 / 1.25 / 1.50** for 6 oz / 10 oz / 12 oz liquid.
- Per-show batch = *(L/Guest) × (expected guests for that show)*.  
  Totals across **all** specialty cocktails per show ≈ **26.7 L**, **29.1 L**, **19.0 L**, **28.3 L**, **25.9 L**, **32.3 L** (in date order).

Want this split per show by drink or converted into 1 L / 1.75 L bottle counts?

---

## User

Batches are done in 18L or 9L so tell me what to prepare of each

---

## Assistant

Mr. White — batching in **18 L / 9 L** (assumes **8 oz liquid** per drink).

### Week plan (meets forecast with minimal whole batches)
| Drink | Need (L) | Batch plan | Prep (L) | Over (+L) | ≈Drinks Covered |
|---|---:|---|---:|---:|---:|
| Black Magic | 33.6 | **2×18 L** | 36 | +2.4 | 152 |
| Wicked Watermelon | 28.7 | **2×18 L** | 36 | +7.3 | 152 |
| Beetle Juice | 27.0 | **1×18 L + 1×9 L** | 27 | +0.0 | 114 |
| Main Bar Test Print | 23.2 | **1×18 L + 1×9 L** | 27 | +3.8 | 114 |
| Old Hollywood | 21.9 | **1×18 L + 1×9 L** | 27 | +5.1 | 114 |
| Laughing Gas | 13.8 | **1×18 L** | 18 | +4.2 | 76 |
| Scream-tini | 8.7 | **1×9 L** | 9 | +0.3 | 38 |
| SHOT: Scooby Snacks | 3.8 | **1×9 L** | 9 | +5.2 | 38 |

**Totals:** prepare **189 L** for specialty cocktails (forecast use ≈ **160.7 L**; buffer ≈ **28.3 L** ~120 drinks).

**Notes**
- If **Scooby Snacks is a 2 oz shot**, forecast use ≈ **0.94 L** (≈16 shots); a single **9 L** batch would cover ~152 shots—consider making this to order.
- Different liquid builds: multiply liters by **0.75 / 1.25 / 1.50** for **6 oz / 10 oz / 12 oz** pours.

---

## User

For laughing gas I use 2 oz of empress gin and it comes in 750ml bottles so tell me how much of that i need.


---

## Assistant

Mr. White — for **Laughing Gas** (2 oz Empress per drink):

- **Forecast drinks:** ≈58  
- **Empress needed:** **3.43 L** (≈**4.57** × 750 mL) → **plan on 5 bottles**

Batch options:
- **One 18 L batch** (≈76 drinks): **4.50 L** → **6 bottles**
- **One 9 L batch** (≈38 drinks): **2.25 L** → **3 bottles**

---

## User

So for this weekend, for Blackmagic, Wicked Watermelon, Beetlejuice, Old Hollywood, and Screamtini, how much should I prepare in liters, and if we want, we can just prepare the actual liter amounts, total, yeah, just give me the total liters that I theoretically would need.

---

## Assistant

Mr. White — assuming 8 fl oz liquid per drink and weekend = Fri–Sun shows (≈666 guests total):

| Drink | Prep (L) |
|---|---:|
| Black Magic | **28.1 L** |
| Wicked Watermelon | **23.9 L** |
| Beetle Juice | **22.5 L** |
| Old Hollywood | **18.4 L** |
| Scream-tini | **7.3 L** |

**Total (these 5): ~100.1 L**

If you change the build: multiply by **0.75 / 1.25 / 1.50** for 6 / 10 / 12 oz pours.


**Topic:** [[chatgpt-clusters/business_startup]]
