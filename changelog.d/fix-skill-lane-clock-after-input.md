**Hermes turns with a long conversation get their skill suggestions again: the skill resolver's 50 ms turn clock now starts after the hook's input is read.**

<!-- behavior-change: skill_lane_clock_after_input_10334 -->

### Fixed
- The skill-resolver hook lane started the turn's 50 ms clock when its worker thread loaded, a few ms in, while Hermes was still piping the whole conversation history into stdin (about 4 ms per MB). A history of 20 MB or more timed out on every turn and about 10 MB sat at the edge, so long Hermes sessions lost their `<relevant_skills>` block (#10334). The clock now starts once the worker has loaded and the input has been read; the existing 250 ms start bound caps both, so a stdin that never finishes still ends the turn with no output.
