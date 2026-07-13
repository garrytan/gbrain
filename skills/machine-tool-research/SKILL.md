---
name: machine-tool-research
description: Research machine tools and mechanical equipment with emphasis on requested components, dimensional evidence, manuals, drawings, seller photos, and compatibility checklists.
triggers:
  - machine tool research
  - machine head flange dimensions
  - станок паспорт
  - голова станка
  - ВФГ
  - чертеж станка
  - межцентровые расстояния
  - совместимость узлов станка
writes_pages: false
mutating: false
---

# Machine Tool Research

## Contract

A run of this skill is complete when:

1. The exact component/interface question is restated before background specifications.
2. Primary or near-primary sources are searched: manuals, passports, drawings, repair docs, owner threads, and seller photo evidence.
3. Found values are separated from missing dimensions and inferred values.
4. Compatibility claims focus on interfaces: centering, bolt pattern, dowels, axis offsets, gear mesh, spindle taper, and rotation.

## Output Format

- Short answer.
- Found dimensions table: item, value, source, confidence.
- What the drawing/source actually says.
- Still missing dimensions.
- Measurement or seller-photo checklist.

## Anti-Patterns

- Answering with generic machine specifications when the user asked about one interface.
- Estimating precise diameters or bolt centers from unscaled angled photos.
- Treating similar spindle taper or speed range as proof of mechanical interchangeability.

## Procedure

Use this skill for research on metalworking machines, Soviet/industrial machine-tool passports, machine heads, spindles, flanges, tables, gearboxes, accessories, and compatibility between mechanical assemblies.

### Core rule: answer the component question, not the whole machine

If the user asks about a specific part (e.g. `голова`, `ВФГ`, `фланец`, `межцентровые`, `посадка`, `шестерня`), do **not** lead with generic machine specifications. Generic TTX is background only and should be a short appendix unless it directly constrains the part.

For component-focused machine-tool research: when the user asks for dimensions/compatibility, provide evidence about the **requested interface** — flange, bolt pattern, centering spigot/recess, gear mesh, axis offsets — not a broad overview of the станок.

### Research sequence

0. **Respect the user’s actual workflow/state**
   - If the user says the part is already bought/owned, stop framing the answer as purchase advice. Treat it as bench diagnosis, adaptation, measurement, and repair.
   - If the user complains that the answer is technically shallow, immediately broaden beyond the single model: read repair practice for the underlying machine-tool class (quill bores, spindle heads, clamps, plain bearing fits, sleeves, scraping/honing), then return with a grounded engineering position.

1. **Restate the exact interface being investigated**
   - Example: “Need dimensions of the 675П vertical head mounting flange: centering diameter, bolt centers, dowel positions, distance from mounting plane to drive gear axis.”
   - Keep this as the search spine.

2. **Search for primary or near-primary sources**
   - паспорт / руководство по эксплуатации
   - альбом быстроизнашиваемых деталей
   - сборочные чертежи узлов
   - ремонтная документация
   - профильные форумы and long owner threads (for Soviet/Russian станки, Chipmaker is first-class evidence)
   - seller/listing archives such as DirectLot for real photos, document leads, and field measurements
   - catalog sheets only as secondary evidence
   - seller photos only as field evidence

   For deep machine-tool tasks, do not treat this as a quick lookup unless he explicitly asks for one narrow fact. Default to a real deep dive: spend sustained tool time, mine forum threads/listings/manuals, and build a reusable knowledge base so later questions about gearboxes, feeds, slides, heads, or lubrication can be answered from context rather than starting over.

3. **Extract and inspect drawings, not just text**
   - Download PDFs/DJVU/images when available.
   - Render pages/images if text extraction misses drawings.
   - Inspect relevant figures with vision.
   - Save/quote the useful drawing filenames and page numbers in the answer.

4. **Separate found facts from missing dimensions**
   - Use a table:
     - dimension needed
     - found value
     - source
     - confidence
   - If a dimension is not visible, say “not found in accessible sources” rather than inferring from photos.

5. **For compatibility, focus on interfaces**
   - centering spigot / recess diameter and depth
   - bolt pattern and thread/clearance
   - dowel/fixing pins
   - mounting plane to spindle axis
   - mounting plane to drive gear axis
   - gear module, tooth count, face width, handedness/direction
   - spindle taper and drawbar/retention
   - rotation direction and usable speed range

6. **When the user provides photos or already-owned parts**
   - Describe only visible geometry; do not invent dimensions.
   - First infer ownership/workflow from the user’s wording: if the part is already bought/owned, do **not** frame the answer as buying advice or “ask the seller” unless the user explicitly says a seller is involved.
   - For owned hardware, give a bench measurement checklist: what to measure with calipers, what faces/axes to reference, and how the measurement affects adaptation/repair.
   - If useful, create a measurement checklist or annotated measurement plan.

### Output format for component/dimension research

Prefer concise, evidence-oriented structure:

```markdown
### Short answer
<what is known / not known>

### Found dimensions
| Interface item | Value | Source | Confidence |
|---|---:|---|---|

### What the drawing actually says
- quoted/translated source text
- figure/page numbers

### Still missing
- exact list of dimensions not found

### What to measure / ask seller
1. ...
```

Avoid burying the answer under general background.

### Pitfalls

- **Wrong workflow assumption:** If the user says the part is already bought/owned, stop giving purchase/seller advice. Treat the task as identification, measurement, adaptation, or repair research.
- **Wrong scope:** Do not answer “what is model 675П” when the user asked “what are the flange dimensions of the 675П head.”
- **Photo overreach:** Never estimate precise flange diameters or bolt centers from an unscaled angled photo. Use it only to identify features and define measurements.
- **Catalog-sheet trap:** Catalog PDFs often include general working-space dimensions but omit the part interface. Say so and keep searching for assembly drawings or repair albums.
- **False compatibility:** Similar speed ranges or same spindle taper do not prove head interchangeability. Mechanical interface and gear mesh decide.
- **Do not conflate donor scopes:** Whole-head mounting, internal parts swaps, and using a bare head корпус are separate questions. A 6М76П/676П ISO40 spindle/quill may be relevant as an internal donor, but that does not make a 6М76П/676П head корпус a good donor for a 675П machine. For 675П корпус questions, first distinguish 675-series 150 mm bolt-spacing heads from 676-series 170 mm heads.
- **Do not mis-model the quill lock:** On 675/675П/676-style ВФГ, a “треснутое ухо фиксации пиноли” may be the integral split-clamp zone of the head body around the quill bore, not a separate external lug. Inspect photos first, then talk about clamp-cheek repair/bypass.
- **Keep clearance and clamp failure separate:** Repairing a cracked quill clamp does not remove quill/bore clearance. If a 6М76П ISO40 quill is ~71.9 mm in a 675П bore near 72 mm, ~0.10 mm play is expected unless the bore/quill fit is separately sleeved or rebuilt.
- **Marketplace grounding:** For DirectLot/Avito parts research, verify live `В наличии`/seller text before calling a listing a candidate. DirectLot is usually rich in images and seller measurements; Avito may expose useful card snippets without login but avoid phone/login flows.
- **Correction pattern:** When the user pushes back on a machine-tool compatibility claim, stop extrapolating and re-check Chipmaker/manual/listing-photo evidence for the exact interface. Keep the answer concise and technical; do not repeat already-established basics like “П vs без П internals differ” when the user is asking a narrower корпус/casting question.
- **Do not confuse automatic tool change with powered clamp/unclamp:** For 6М76П-style ISO40 VFG questions, documented “зажим/отжим инструмента” may be an electromechanical/inertial drawbar mechanism (power drawbar), not a full ATC. Look for evidence of magazine/manipulator/cycle before calling anything “автосмена инструмента.” If the user asks “how to google this,” lead with terms like `электрозажим`, `автозажим`, `зажим-отжим`, `штревель`, `переходник между шомполом и патроном`, and `power drawbar`, not `автосмена инструмента`.

### Reference files

- `references/675p-vertical-head.md` — session notes on 675П vertical head research, sources checked, known textual evidence, missing flange dimensions, and DirectLot document leads.
- `references/quill-bore-repair.md` — class-level notes on quill/pinole bore wear, lock-vs-feed behavior, measurement protocol, and repair options such as bronze/cast-iron sleeves or Moglice.
- `references/675p-chipmaker-compatibility.md` — Chipmaker-derived compatibility notes for 675/675П/676П/6М76П VFGs, including 150 vs 170 mm mounting families, “рожки/лыски” gear families, and the specific pitfall of confusing корпус donors with internal-part donors.
- `references/675p-vfg-clamp-marketplaces.md` — notes on the user's working 675П+6М76П ISO40 conversion, cracked VFG quill clamp/split-clamp failure evidence, DirectLot dimensions/listings, and Avito/DirectLot access patterns.
- `references/6m76p-tool-clamp.md` — evidence that 6М76П has electromechanical tool clamp/unclamp (power-drawbar-like), not documented full automatic tool change; includes drawbar/ball-clamp details and implications for a 675П+ISO40 conversion.

## Verification Checklist

- [ ] The answer is grounded in current sources or explicit live probe output when the task requires freshness.
- [ ] Private credentials, cookies, sessions, personal names, and internal infrastructure are absent or redacted.
- [ ] Uncertainty is labeled instead of hidden behind a confident recommendation.
- [ ] The final response gives the user a concrete next action, not only background context.
