# Quill / pinole bore repair notes

Use for milling heads, tailstocks, drill presses, and similar machine-tool quill systems where a cylindrical sleeve (`пиноль` / `гильза`) slides in a cast housing and is locked by a clamp.

## Core distinction

A quill lock does not make a worn bore geometrically correct. It usually pushes the quill to one side of the worn bore.

- **Milling with quill retracted and locked:** quill-to-body clearance is less harmful if the lock actually removes motion at the tool nose.
- **Drilling/boring with quill feed:** the lock is released or only lightly dragged; bore clearance directly becomes tool wander, chatter, and accelerated wear.
- **Milling with extended quill:** worst case for a worn quill bore because the overhang amplifies motion.

For the user-style answers: do not accept “там же прижим, пофиг” without separating these modes.

## Bench test protocol

1. Put an indicator on a test bar/tool holder at the spindle nose.
2. Quill fully retracted, lock released: push/pull in X and Y, record motion.
3. Quill fully retracted, lock tightened normally: repeat.
4. Quill extended 30–50 mm, lock released: repeat.
5. Quill extended 30–50 mm, lock tightened: repeat.
6. Lock the quill and then separately test spindle/bearing play at the nose. If motion remains with the quill locked, it may be spindle bearings/shaft fits, not the quill bore.

## Practical interpretation

Approximate guidance for old manual machine heads:

| Indicated motion at nose/body fit | Interpretation |
|---:|---|
| 0.00–0.02 mm locked | Usually usable for hobby/manual milling if geometry is acceptable |
| 0.03–0.05 mm locked | Usable only for rough work; expect marks/chatter |
| 0.07–0.10 mm locked | Clamp is not solving it; repair should be planned |
| ~0.10 mm unlocked | Significant for drilling/feed work; expect wear and wander |

Do not confuse indicator motion at a long test bar with diametral clearance; overhang amplifies angular rock.

## Repair decision tree

1. Measure the quill OD with micrometer in 3–5 axial positions and two angular directions.
2. Measure the housing bore with an inside micrometer/bore gauge in matching positions/directions.
3. Classify the problem:
   - quill worn/tapered/oval;
   - housing bore worn/tapered/oval;
   - both worn;
   - clamp geometry not closing because of bottoming/clearance issues.
4. If the quill is good and the housing is worn: bore the housing and install a repair liner/bushing, then finish-machine the ID in situ to the actual quill.
5. If the quill is undersize/worn: consider regrind + plating/metal spray, a new quill, or a liner deliberately matched to this exact quill.

## Repair methods seen in practice

- **Cast iron/Durabar sleeve:** close to traditional machine-tool sliding pairs; good for large, stable repairs.
- **Bronze sleeve:** acceptable and practical for a quill guide if enough wall thickness remains, lubrication is provided, and the quill surface is smooth.
- **Moglice/Turcite-style cast bearing compounds:** used in reconditioning to rebuild worn quill bores, but requires careful release agent, dams/vents, injection/packing, and alignment.
- **Shim stock:** temporary diagnostic or cheap fix; can help prove where clearance is, but is not a geometric restoration.

## Practical Machinist reference data point

Thread: “Tailstock quill bore and Moglice” (`practicalmachinist.com/forum/threads/tailstock-quill-bore-and-moglice.423428/`).

Reported values:

- quill lifted **0.0015 in** when clamped ≈ **0.038 mm**;
- bore measured **0.003 in** oversize at the front ≈ **0.076 mm**;
- comparable machines had less than **0.0005 in** lift ≈ **0.013 mm**;
- initial repair idea was to bore and sleeve with Durabar; final explored method used Moglice to rebuild the quill bore.

This supports treating ~0.1 mm quill/body looseness as a real repair issue, especially for feed drilling/boring.

## Pitfalls

- Do not claim a bronze sleeve is automatically correct: first verify wall thickness, oiling, quill surface condition, and alignment reference.
- Do not finish the sleeve loose on a lathe and just press it in; final ID should be bored/reamed/honed after installation in the housing when possible.
- Do not over-tighten a split clamp to compensate for wear; old castings can crack or lose geometry.
- Do not diagnose “bearings” until quill/body motion has been isolated from spindle/bearing play.