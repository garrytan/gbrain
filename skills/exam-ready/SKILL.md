---
name: exam-ready
description: >
  Activate this skill when a student provides study material (PDF or pasted notes)
  and a syllabus, and wants to prepare for an exam. Extracts key definitions,
  points, keywords, diagrams, exam-ready sentences, and practice questions
  strictly from the provided material.
triggers:
  - "exam-ready"
  - "exam ready"
  - "awesome copilot exam ready"
---

# exam-ready

Activate this skill when a student provides study material (PDF or pasted notes)
and a syllabus, and wants to prepare for an exam.

## What this skill does

For each syllabus topic, extract from the provided material:
- What it is (1 line definition — exam-ready)
- 3–5 key points an examiner expects
- Important keywords to use in the answer (bold them)
- Any important diagram or figure — describe what it shows in 2 lines
- 1–2 sentences the student can directly write in their exam answer (or MCQ trick if exam type is MCQ)
- 1 examiner-style practice question to test recall

Do NOT explain the full topic. Do NOT add context outside the provided material.
Do NOT explain things the syllabus didn't ask for.
Never tell the student to "read more" or "refer to chapter X". Give them what they need right here.

## Input format

Student will provide:
1. A PDF file or pasted notes (their study material)
2. A syllabus — either pasted as text or listed as topics
3. Optionally: exam type (MCQ / short-answer / long-answer) and time available

## Handling missing inputs

- If no study material is provided: say "Please share your notes or PDF first. I won't use outside knowledge."
- If no syllabus is provided: say "Please list your syllabus topics so I cover exactly what's being tested."
- If exam type is not mentioned: default to long-answer format, but ask once: "Is this MCQ or written?"
- If a topic is not found in the provided material: say "This topic was not found in your notes. Check your material."

## Triage mode (when student gives a time constraint)

If the student says "I have X hours":
1. First, output a **priority list** — number all syllabus topics in order of:
   - Explicit weightage (if syllabus mentions marks)
   - Frequency of appearance in the PDF (more coverage = higher priority)
   - Breadth of subtopics under it
2. Then expand each topic in that priority order, not syllabus order.
3. If time is very short (≤1 hour), cut output to definition + key points + exam line only. Skip diagrams.

## Output format per topic

---

### [Topic Name]

**Definition:** [1 sentence]

**Key Points:**
- [point 1]
- [point 2]
- [point 3]

**Keywords to use:** keyword1, keyword2, keyword3

**Diagram (if any):** [What the diagram shows and what to label]

**Write this in your exam:** *(skip if MCQ — show MCQ trick instead)*
[1–2 ready-to-write sentences the student can use directly]

**MCQ trick:** *(only if exam type is MCQ)*
[How to identify the correct option or eliminate wrong ones for this topic]

**Cross-references:** *(only if this topic's keywords appeared in another topic)*
[e.g., "The term 'X' used here also appears in [Topic Y] — examiners may link them"]

**Practice question:**
[1 examiner-style question to test recall on this topic]

---

## Rules

- Stay strictly within the provided material. Do not add outside knowledge under any circumstance.
- If exam type is MCQ, replace "Write this in your exam" with "MCQ trick".
- If no weightage is given in the syllabus, prioritize topics that appear most in the PDF.
- If a keyword from one topic reappears in another, flag it under "Cross-references".
- If the PDF contradicts the syllabus topic name or scope, use the PDF content but note: "Your notes cover this as [X] — answering based on that."
- Keep everything short. The student is cramming, not researching.

## Trigger phrases

- "I have an exam tomorrow on [subject]"
- "explain [topic] from my notes"
- "what do I need to know about [topic] for my exam"
- "go through my syllabus"
- "I only have [X] hours, help me prepare"
- "quiz me on [topic]"


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `exam-ready`: >
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
