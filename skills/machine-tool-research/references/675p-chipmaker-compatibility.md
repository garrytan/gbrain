# 675 / 675П / 676П / 6М76П VFG compatibility notes

Session-derived research notes for future machine-tool work on Soviet 675-series vertical milling heads (ВФГ). Treat as a compact evidence index, not a substitute for measuring the actual hardware.

## Critical workflow lesson

Do not conflate these three different donor questions:

1. **Whole head onto a machine** — mounting bolt spacing, centering spigot/recess, drive gear interface.
2. **Internals/potroha between heads** — quill/spindle, bevel gear pair, shafts, bearings, covers.
3. **Bare head корпус as a casting** — internal bores, axis positions, bearing seats, quill bore, clamp geometry.

A donor that is plausible for internals (e.g. 6М76П ISO40 spindle/quill) is not automatically a plausible donor for the bare head корпус on a 675П machine.

## Chipmaker access pattern

Direct `chipmaker.ru` can be slow/blocked. Use Jina reader URLs:

```text
https://r.jina.ai/http://r.jina.ai/http://https://www.chipmaker.ru/search/?q=<urlencoded query>
https://r.jina.ai/http://r.jina.ai/http://https://www.chipmaker.ru/topic/<topic_id>/?do=findComment&comment=<comment_id>
```

Useful topics/comments found:

- `147283` — “Валы от ВФГ 676п”; key correction on 675 vs 675П whole-head install and non-interchangeable details.
- `148401` — “Различие внутренностей ВФГ 675 676”; notes on 675П/676П internals, 32 mm splined spindle, several head/quill variants.
- `159038` — “Конические шестерни ВФГ 675”; old/new bevel gear pair types.
- `184773` — “Вгф 675 на станок 676...”; 675 vs 676 mounting families and 676/6М76P cautions.
- `245667` — “Вопрос по ВФГ 675П”; bolt spacing and gear type note.

## Evidence snippets / conclusions

### 675-series mounting vs 676-series mounting

- Chipmaker topic `245667`: 675 VFG bolt spacing is reported as **150 mm**, 676 as **170 mm**.
- Topic `184773`: to fit a 675 head to 676/676П/6М76П, an adapter flange is needed; 675 bolt spacing is 20 mm less than 676.

**Implication:** for a 675П machine, a 676П/6М76П *head корпус* is not the first-line корпус donor. It is a different mounting family. Use 676П/6М76П mainly as a reference/donor for specific compatible internals only after measurement.

### 675 без П vs 675П — whole head and internals

From topic `147283` (“Валы от ВФГ 676п”):

- If both heads have 150 mm bolt spacing, both are from the 675-series: one from 675, one from 675П.
- Details in those heads are **not interchangeable**.
- A whole 675 head can be installed on a 675П, but there are differences in:
  - **посадочный поясок**;
  - **приводная шестерня**.
- For the spigot/seat: may need a different spindle-head bearing cover made to the VFG seat size.
- For the gear: one discussed workaround involved removing “рожки” and making an extended shaft.

**Implication:** `bare корпус 675 без П + all 675П internals` is not a proven bolt-on swap. It is a candidate only for measurement/machining. However, it is a more relevant корпус candidate than 676П/6М76П because it is still 675-series mounting.

### “П” vs “без П” gear families

From topic `245667` and `159038`:

- 675П drive gear: **с рожками**.
- 675 без П: **с лысками**.
- Old type “с лысками” from 675/676 and new type “с рожками” from 675П/676П are not interchangeable and are installed as matched pairs.

### 675П / 676П internals

From topic `148401`:

- “New” 675П/676П with **32 mm splined spindle**: spindle+quill, gears, and shafts are reported interchangeable; корпус differs.
- At least 3 quill/spindle variants and ~5 head variants were seen by one experienced participant.
- ISO40 heads exist.

**Implication:** 6М76П ISO40 quill/spindle can be a plausible internal donor in a 675П-related repair, but the actual quill bore fit must be measured. In the user's case, an Odessa 675П with 6М76П ISO40 quill physically fits but shows about **0.10 mm quill/body clearance**, so the repair question is quill-bore fit, not abstract “does it fit”.

## Practical answer template for future sessions

If asked: “Can I put all 675П internals into a bare 675 без П head body?” answer:

- Do **not** say yes.
- Do **not** redirect to 676П/6М76П as better корпус donors.
- Say: “Not proven bolt-on; Chipmaker says 675 and 675П head details are not mutually interchangeable, but whole 675 head can be fitted to 675П with work on the seating spigot and drive gear. A bare 675 body is only a measurement/machining candidate.”

Then request/measure:

1. 150 mm bolt spacing confirmation.
2. Centering spigot/recess diameter and depth.
3. Quill bore diameter, length, ovality/taper.
4. Bearing-seat diameters/depths for the 675П internals.
5. Shaft center distances, especially the bevel gear pair.
6. Clearance/window for “рожки” gear type.
7. Quill clamp geometry and oiling holes.

## Tone / interaction pitfall

For deep machine-tool research, avoid confident extrapolation from one compatibility family to another. When challenged, immediately narrow the question and go back to primary forum/document evidence. The user expects concise, technically discriminating answers, not broad donor lists.