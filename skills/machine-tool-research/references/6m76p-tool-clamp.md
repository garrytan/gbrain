# 6М76П tool clamp vs “автосмена инструмента”

Session-derived note for future 675П/6М76П VFG research.

Local mirror/index for this research thread:

- `/root/research/675p/INDEX.md`
- `/root/research/675p/notes/6m76p-electrozazhim-power-drawbar.md`
- `/root/research/675p/notes/directlot-search-tags.md`

Gbrain pages:

- `machines/675p-research-chipmaker-directlot`
- `machines/6m76p-tool-clamp`

## User question

the user recalled seeing claims that 6М76П had “автосмена инструмента” for the VFG/vertical head.

## Grounded finding

Accessible 6М76П documentation supports **electromechanical tool clamp/unclamp**, not a full automatic tool changer.

This is closer to a **power drawbar / inertial drawbar clamp** than to ATC.

## Evidence from 6М76П page/passport text

Organs of control list:

- 14 — tool clamping in the horizontal spindle;
- 15 — tool unclamping in the horizontal spindle;
- 16 — tool clamping in the vertical spindle;
- 17 — tool unclamping in the vertical spindle.

Mechanism description:

- consists of drawbar (`шомпол`) 10, nut 12, flywheel 13 with pawls 11, and electric motor 16;
- motor rotates the flywheel;
- when inertia torque is reached, a pawl overcomes spring force and transmits rotation to the nut via a driver;
- the drawbar moves axially;
- four balls pull the tool into the spindle;
- clamping force up to **12000 N**;
- clamp/unclamp time **3–4 s**;
- guaranteed clamp requires two mechanism actuations;
- warning: clamp/unclamp in the vertical head must be done with the quill/gильза in the upper position.

Electrical equipment list:

- **M3** — motor for tool clamp/unclamp of vertical spindle, СЛ-261, 0.24 kW, 3600 rpm, 110 V;
- **M4** — motor for tool clamp/unclamp of horizontal spindle, СЛ-261, 0.24 kW, 3600 rpm, 110 V.

## Interpretation

Do **not** call this “автосмена инструмента” unless a source shows a magazine/manipulator/cycle. The documented feature automates only the drawbar clamp/unclamp; the operator still changes the tool by hand.

Use these search terms instead of `автосмена инструмента`:

- `электрозажим ВФГ 6М76П`
- `ВФГ 6М76П с электрозажимом`
- `электрозажим инструмента 6М76П`
- `зажим отжим инструмента вертикального шпинделя 6М76П`
- `шомпол электрозажим 6М76П`
- `переходник между шомполом и патроном 6м76п`
- `штревель 6М76П электрозажим`
- `штревель под электрозажим`
- `автозажим ISO40 ВФГ`
- `гидрозажим ISO40 ВФГ`
- `power drawbar ISO40 drawbar pull stud`

## Chipmaker evidence checked

### Topic 237834 — `ВФГ 6М76П с электрозажимом`

Useful facts:

- source directly describes a **6М76П VFG with electromechanical clamp and ISO40 taper**;
- removal problem around the drawbar: one reply says there is likely a **left-hand thread nut** and a peened-over drawbar may prevent removal;
- author’s fix: remove the **upper first gear block** and unscrew the **set screw in the spindle**;
- author says the construction is “fully identical with 676П” in this area;
- electromechanical clamp is useful specifically with CNC/ISO holders because of the **pull stud / штревель**;
- practical nuisance: different holders/spindles/threads may require several different drawbars or pull studs.

### Topic 235256 — `Переходник между шомполом и патроном на 6м76п`

This topic is important because the motorized drawbar is not enough: the toolholder side needs the right **штревель / transition pull stud**.

Useful facts:

- the user had a 6М76П but previous owners kept the quick-change adapters;
- one holder thread mentioned: **M16**;
- forum answer to “what is this called?”: **штревель**;
- a standard DIN69872 pull stud may not mate with the 6М76П drawbar geometry; the issue described is incompatible `male/male` ends;
- for the electric clamp a participant calls for a “хитросделанный переходник” / nonstandard pull stud;
- photo example from 6Р12 was offered as the same principle “под электрозажим”;
- participants warn that different toolholders have different thread/depth geometry, so without holder standardization the system becomes tedious.

## DirectLot marketplace pattern

Exact DirectLot searches for `электрозажим 6М76П`, `ВФГ 6М76П`, `шомпол 6М76П`, `зажим инструмента 6М76П`, and `СЛ-261` can return mostly false positives because of `76` and `Р6М5`. Use broader synonyms (`автозажим`, `гидрозажим`, `ВФГ ISO40`) and then inspect individual listings.

Relevant non-bolt-on analogy found:

- DirectLot lot `1837993`: “Вфг MAXO MX 400 с автозажимом”, ISO40, **hydraulic tool clamp**, 55k RUB, with an extra hydraulic clamp under repair.
- This is not a 675П/6М76П donor without major adaptation, but it confirms marketplace vocabulary: sellers may write `автозажим` or `гидрозажим`, not `электрозажим`.

## Practical implication for the user's 675П + 6М76П ISO40 quill

If his 6М76П ISO40 spindle/quill retained the drawbar/ball-clamp architecture, it may be possible to preserve or adapt fast electric clamp/unclamp on the 675П conversion. This is separate from:

- the cracked 675П VFG split-clamp/lug problem;
- the expected ~0.10 mm quill/body clearance from 71.9 mm 6М76П quill in a ~72 mm 675П bore;
- full tool-changing automation, which is not evidenced here.

Before proposing a design, verify these physical items on the actual head:

1. Whether the spindle still has the 6М76П ball-clamp/drawbar features or only a manual threaded drawbar path.
2. Actual drawbar thread, length, stroke, and whether any left-hand threaded nut remains.
3. Holder interface: ISO40 holder thread (e.g. M16 in the Chipmaker example) and required pull-stud/transition geometry.
4. Whether the clamp drive should copy the штатный electromechanical inertial unit (motor + flywheel + pawls + nut) or use a modern pneumatic/hydraulic/servo power drawbar.
5. Whether the design includes force/stroke/torque limiting; avoid “just spin the drawbar with a motor until it stalls.”
