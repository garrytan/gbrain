# 675/675П VFG clamp fracture and marketplace access notes

Session-derived notes for future 675-series VFG work. Use as an evidence index and workflow reminder; do not treat marketplace listings as guaranteed current unless rechecked live.

## User-specific factual anchor from this research class

the user's current 675П configuration (also stored in memory):

- Odessa 675П, bought for roughly 125k ₽.
- Goal achieved: ISO40 on 675П by integrating a 6М76П quill/spindle assembly.
- 6М76П quill OD is about **71.9 mm**; 675П head bore is about **72.0 mm**, so about **0.10 mm** clearance is expected and not the open question.
- Spline drive fit is acceptable despite minor play.
- Open problem: cracked/broken VFG quill clamp ear / split-clamp zone in the 675П head body.

When answering future questions, do not re-litigate whether the ISO40 quill swap “works”; treat it as already successfully integrated. The unresolved repair target is the clamp/body fracture unless the user says otherwise.

## Correct mental model: quill clamp geometry

Do not imagine a separate external lug unless the actual photo shows one. On 675/675П/676-style VFG bodies, the quill lock is often an **integral split-clamp section of the head body** around the quill bore:

- cylindrical body surrounds the quill/pinole bore;
- a slot/split creates two clamping cheeks;
- a tightening screw draws the cheeks together to lock the quill;
- when over-tightened or cracked, the broken feature is part of the body’s split clamp, not just a replaceable tab.

If the user reports “треснуто ухо фиксации пиноли”, first inspect/listing photos or ask for photos and identify the exact split-clamp damage before proposing repair.

## Evidence: DirectLot and photos

DirectLot lot `761386` — “Корпус ВФГ 676 лот2”:

- Description: “есть сварка в месте зажима пиноли, трещина в месте затяжки винта пиноли.”
- Seller later says approximate quill bore diameter: “примерно 72мм”.
- This is useful field evidence that quill-lock cracking at the clamp screw is a known failure mode on related VFG bodies.

DirectLot lot `1316569` — “Стальной корпус ВФГ 675”:

- Description says: `Ф отверстия под пиноль 71.98-71,99` and `Посадочный 105`.
- Seller explicitly notes a steel body/fabricated flange and jokes that “зажим уж точно не лопнет”, implying cracked cast clamp zones are a known pain point.
- Useful dimensions to remember as field evidence, not a drawing: quill bore about 72 mm; mounting/seat about 105 mm for that body.

DirectLot lot `1712104` — VFG 675 assembly:

- Photos available; useful for visual shape of complete 675-style VFG but not a dimensional source.

## Marketplace access pattern verified in session

### DirectLot

DirectLot was accessible via both browser and `web_extract` for searches and individual lot pages.

Useful searches:

```text
https://directlot.ru/products.php?t=%D0%92%D0%A4%D0%93%20675
https://directlot.ru/products.php?t=675%D0%9F%20%D0%92%D0%A4%D0%93
https://directlot.ru/products.php?t=%D0%BA%D0%BE%D1%80%D0%BF%D1%83%D1%81%20%D0%92%D0%A4%D0%93%20675
```

DirectLot sometimes renders Cyrillic query text as mojibake in titles/search boxes, but result content, lot titles, prices, availability, seller notes, and image URLs are readable.

A live search during the session found `lot 1242696` with `В наличии: 1`, but that lot was not a stock 675П VFG: it was a Bridgeport-style/possible foreign head with hobo/hob attachment, useful only as a DirectLot access test unless the user is evaluating a custom donor.

### Avito

Avito search was accessible through browser for:

```text
https://www.avito.ru/all/oborudovanie_dlya_biznesa?q=%D0%B2%D1%84%D0%B3+675
```

The browser could see result cards, prices, descriptions, regions, and snippets without login/captcha in this session. Example visible results included:

- “Фрезерный станок 675П Одесса” — 50k ₽, description said “ВФГ продана!”
- “Фрезерный станок 675 запчасти” — listing snippet included “ВФГ -20000”.

Do not click phone/login/payment flows. For Avito, use accessible card snippets and listing pages; if details require auth, report that boundary.

## Repair framing for cracked clamp + 0.10 mm quill clearance

Separate the two issues:

1. **Quill clearance** — expected from 6М76П quill OD about 71.9 in a 675П bore about 72.0. This remains unless the bore is sleeved/reworked.
2. **Clamp fracture** — current open issue: the split-clamp/ear must be structurally repaired or bypassed so the quill can be locked without further breaking the body.

Avoid telling the user “fixing the clamp will remove the 0.10 mm play.” It will not. If the goal is only to preserve the already-working ISO40 conversion, propose clamp repair/bypass first; sleeve/bore correction is a separate later precision upgrade.

## Practical answer pattern

When the user asks about this VFG again:

- Start with the known facts in 2–4 lines; do not re-explain 675П basics.
- Acknowledge ISO40 conversion is already achieved.
- Focus on the cracked split-clamp/ear.
- If recommending a donor body, distinguish:
  - whole head donor;
  - bare корпус donor;
  - internals donor.
- For marketplace work, verify live listings and their `В наличии` status before saying they are candidates.
