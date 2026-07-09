---
name: java-docs
description: 'Ensure that Java types are documented with Javadoc comments and follow best practices for documentation.'
triggers:
  - "java-docs"
  - "java docs"
  - "awesome copilot java docs"
---

# Java Documentation (Javadoc) Best Practices

- Public and protected members should be documented with Javadoc comments.
- It is encouraged to document package-private and private members as well, especially if they are complex or not self-explanatory.
- The first sentence of the Javadoc comment is the summary description. It should be a concise overview of what the method does and end with a period.
- Use `@param` for method parameters. The description starts with a lowercase letter and does not end with a period.
- Use `@return` for method return values.
- Use `@throws` or `@exception` to document exceptions thrown by methods.
- Use `@see` for references to other types or members.
- Use `{@inheritDoc}` to inherit documentation from base classes or interfaces.
  - Unless there is major behavior change, in which case you should document the differences.
- Use `@param <T>` for type parameters in generic types or methods.
- Use `{@code}` for inline code snippets.
- Use `<pre>{@code ... }</pre>` for code blocks.
- Use `@since` to indicate when the feature was introduced (e.g., version number).
- Use `@version` to specify the version of the member.
- Use `@author` to specify the author of the code.
- Use `@deprecated` to mark a member as deprecated and provide an alternative.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `java-docs`: Ensure that Java types are documented with Javadoc comments and follow best practices for documentation.
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
