---
name: comment-code-generate-a-tutorial
description: 'Transform this Python script into a polished, beginner-friendly project by refactoring the code, adding clear instructional comments, and generating a complete markdown tutorial.'
triggers:
  - "comment-code-generate-a-tutorial"
  - "comment code generate a tutorial"
  - "awesome copilot comment code generate a tutorial"
---

Transform this Python script into a polished, beginner-friendly project by refactoring the code, adding clear instructional comments, and generating a complete markdown tutorial.

1. **Refactor the code**  
   - Apply standard Python best practices  
   - Ensure code follows the PEP 8 style guide  
   - Rename unclear variables and functions if needed for clarity

1. **Add comments throughout the code**  
   - Use a beginner-friendly, instructional tone  
   - Explain what each part of the code is doing and why it's important  
   - Focus on the logic and reasoning, not just syntax  
   - Avoid redundant or superficial comments

1. **Generate a tutorial as a `README.md` file**  
   Include the following sections:
   - **Project Overview:** What the script does and why it's useful  
   - **Setup Instructions:** Prerequisites, dependencies, and how to run the script  
   - **How It Works:** A breakdown of the code logic based on the comments  
   - **Example Usage:** A code snippet showing how to use it  
   - **Sample Output:** (Optional) Include if the script returns visible results  
   - Use clear, readable Markdown formatting


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `comment-code-generate-a-tutorial`: Transform this Python script into a polished, beginner-friendly project by refactoring the code, adding clear instructional comments, and generating a complete markdown tutorial.
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
