# 675П vertical head / flange research notes

Session context: user owns a 6М76П and asked specifically for research on a 675П vertical milling head (`ВФГ`) flange/mounting dimensions, not generic 675П machine specs. User corrected the agent for drifting into general станок TTX.

## Sources checked

- `stanki-katalog.ru/sprav_675p.htm` — full web page scraped; useful text and figures.
- `stanki-katalog.ru/doc_pdf/2762.pdf` — 3-page catalog sheet for 675П; downloaded and rendered.
- `stanki-katalog.ru` images downloaded from the 675П page, notably:
  - `spr_675_pic11_b.jpg` — Fig. 11, “Вертикальная головка”; sectional/outline drawing of the vertical head.
  - `spr_675p_1.jpg` — Fig. 4, “Основные размеры и посадочные места”; general dimensions, not head flange.
  - `spr_675_pods_b.jpg` — bearing layout; includes small accessory schematics, not flange dimensions.
- `lab-metr.ru/675-675p...` and similar mirror pages — mostly copied general data.
- 6М76П references checked for contrast:
  - `stanki-katalog.ru/sprav_6m76p.htm`
  - `dokstan.ru/demo/6m76p.pdf`
  - PromPortal listing for “Вертикальная фрезерная головка 6М76П”

## Textual evidence found for 675П vertical head mounting

From the 675П passport text on stanki-katalog:

> Вертикальная головка является съемным узлом, с помощью которого станок переналаживается из горизонтального в вертикальный.
>
> Вертикальная головка крепится к шпиндельной бабке двумя винтами, при этом головка своей выточкой в корпусе устанавливается на фланец 2 (рис. 12) шпиндельной бабки и тем самым центрируется соосно горизонтальному шпинделю.
>
> Вертикальная головка может поворачиваться на 90° в обе стороны, для этого на фланце корпуса нанесены деления в градусах, а на шпиндельной бабке с правой стороны выгравирован отсчетный индекс. Вертикальное положение головки фиксируется двумя штифтами 24. При необходимости повернуть головку штифты 24 должны быть сняты.

Implications:

- Mount is not a generic flat plate.
- The head has an **answering recess/relief (`выточка`)** in its body.
- It centers on **flange #2** of the spindle head/babка.
- It is retained by **two screws**.
- Vertical position is indexed/fixed by **two pins (#24)**.
- The head rotates ±90° and has a graduated flange/index.

## Dimensions found

These are general head-related values, not the flange pattern:

| Item | Value | Source |
|---|---:|---|
| Vertical spindle speed range, 675П | 63–2040 rpm | stanki-katalog / catalog data |
| Vertical head/spindle quill axial travel | 60 mm | stanki-katalog / lab-metr tables |
| Vertical head swivel angle | ±90° | passport text and tables |
| 675П spindle taper in general tables | Morse 4 | stanki-katalog / lab-metr |

## Quill / pinole (`гильза`) evidence

User later asked specifically for the **diameter of the pinole/quill** of the 675П vertical head. Searches checked: `диаметр пиноли`, `гильза вертикального шпинделя диаметр`, `пиноль вертикальная головка`, `наружный диаметр гильзы`, plus the rendered vertical-head drawing and bearing-layout image.

What is known:

- On Fig. 11 “Вертикальная головка”, the quill/sleeve is **гильза поз. 2**.
- The vertical spindle is **поз. 5**.
- The head body is **поз. 8**.
- The quill axial travel is **60 mm**.
- The spindle is described as mounted in the quill on two radial supports **поз. 1 and 9**; axial loads are taken by bearings **поз. 7**.

What was **not** found in accessible sources:

- exact outside diameter of the quill/pinole;
- exact bore diameter in the head body where the quill slides;
- working drawing of detail `гильза` / `поз. 2`.

Do not infer the quill diameter from the unscaled assembly drawing or photo. For an owned head, measure with calipers: outside diameter of the moving cylindrical sleeve, body bore if accessible, working guide length, and actual travel.

## Dimensions NOT found in accessible sources

The open sources checked did **not** reveal:

- centering flange outside diameter;
- head recess inside diameter;
- recess depth;
- bolt center distance for the two retaining screws;
- retaining screw thread/diameter;
- dowel/pin spacing and diameter for the two vertical-position pins;
- mounting plane to horizontal spindle/drive gear axis;
- drive gear module/tooth count/face width;
- exact drawing of “фланец 2” from the spindle head.

Likely required document class:

- assembly drawing of 675П spindle head (`шпиндельная бабка`);
- assembly drawing of 675П vertical head;
- drawing of detail “фланец 2”;
- repair/quick-wear parts album, not just the common passport/catalog page.

## 6М76П contrast

For 6М76П, the stanki-katalog page lists the vertical head assembly as:

> Головка фрезерная вертикальная — М5П4001А

The 6М76П page/table gives vertical head mass about 55 kg and quill travel 60 mm. This does not prove compatibility with 675П; the mounting interface and drive gear mesh decide.

## Owned-part measurement checklist for a 675П head

When the user already owns the head, frame this as bench measurement/adaptation, not buying advice. Measure:

1. Mounting face straight-on with a ruler/caliper in frame for documentation.
2. Inner diameter and depth of the head’s centering recess / `выточка`.
3. If the mating бабка exists: outside diameter and height of the centering flange/spigot.
4. Center-to-center distance of the two retaining screw holes.
5. Diameter/thread of the retaining screws.
6. Diameter and center-to-center spacing of the two indexing/fixing pin holes.
7. Distance from mounting plane to the drive gear axis.
8. Drive gear tooth count, module if measurable, face width, and gear condition.
9. Distance from mounting plane to vertical spindle axis if adapting to another machine.
10. Spindle taper and drawbar/shompol details.
11. Quill/pinole: outside diameter of moving sleeve (`гильза поз. 2`), body bore if accessible, working guide length, and actual travel.

## DirectLot / Chipmaker leads from follow-up research

DirectLot was useful when normal web search did not surface dimensions. For 675П, use `products.php?t=675%D0%9F&fs=1` for fuzzy search, not only exact search.

Relevant DirectLot findings:

| Item | Lot | Notes |
|---|---:|---|
| `Пиноль 675` | `1770935` | Three real photos of a 675 quill/spindle assembly; description says “Конус чистый, подшипники хорошие”; no caliper/scale, so no OD can be read. |
| `675/675п чертежи быстроизнашивающихся деталей. электронная фотокопия` | `1246166` | Likely key document class for missing quill/flange detail drawings. Seller says it is a page-by-page photocopy; question thread includes photos of drawings. |
| `Альбом материалов по запасным и изнашивающимся деталям 675 и 675п` | `1288290` | Cover reads: “Альбом материалов… Инструментальный широкоуниверсальный фрезерный станок моделей 675 и 675П. Одесса, 1970 г.” Contents list drawings of spare/wearing parts on pp. 18–98 and general assembly views on pp. 99–104. |
| `Инструментальный фрезерный станок 675 675П. Руководство. Большой формат. Оригинал` | `1724908` | Seller notes “Одесский завод по паспорту.” |

Chipmaker direct access may time out from some environments; do not encode that as permanent. If direct access fails, mine DirectLot pages for embedded Chipmaker links/profile IDs and topic URLs, then retry later or via browser. In this session DirectLot pointed to `chipmaker.ru/topic/5606/` and `chipmaker.ru/topic/256553/#comment-5029129`.

A working fallback used in-session was Jina reader around Chipmaker URLs:

```text
https://r.jina.ai/http://r.jina.ai/http://https://www.chipmaker.ru/topic/<TOPIC_ID>/
https://r.jina.ai/http://r.jina.ai/http://https://www.chipmaker.ru/search/?q=675%D0%9F
```

Useful Chipmaker findings to keep handy:

- Topic `245667` (“Вопрос по ВФГ 675П”): forum answer says **675 VFG bolt center distance = 150 mm**, **676 = 170 mm**.
- Topic `184773` says mounting a 675 VFG on 676/676П/6М76П needs an adapter flange; 675 VFG bolt spacing is 20 mm smaller than 676.
- Topic `148401` says newer 675П/676П heads with 32 mm spindle spline are often internally interchangeable (quill+spindle, gears, shafts), but housings differ; “П” and non-“П” internals are not safely interchangeable.
- Topic `105595` discusses quill-feed shaft dimensions; a 22 mm neck appears in one drawing while another user's head had a 25 mm seat, reinforcing that multiple VFG variants exist.
- Store synthesized findings in gbrain after deep research; this lets later questions about the gearbox, X/Y/Z feeds, slides, VFG, pinole, and lubrication start from a knowledge base instead of a fresh search.

## Former seller-photo checklist

If the user is evaluating a remote listing rather than an owned part, ask the seller for the same photos/measurements above instead of assuming access to the part.

## Style lesson from this session

When the user asks for dimensions of a head/flange, start with what was found/missing for that flange. Do not front-load broad model specs; they read as irrelevant filler. If corrected (“уже всё куплено”), switch immediately from buying/seller framing to owned-part diagnosis and repair planning.