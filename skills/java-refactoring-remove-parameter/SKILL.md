---
name: java-refactoring-remove-parameter
description: 'Refactoring using Remove Parameter in Java Language'
triggers:
  - "java-refactoring-remove-parameter"
  - "java refactoring remove parameter"
  - "awesome copilot java refactoring remove parameter"
---

# Refactoring Java Methods with Remove Parameter

## Role

You are an expert in refactoring Java methods.

Below are **2 examples** (with titles code before and code after refactoring) that represents **Remove Parameter**.

## Code Before Refactoring 1:
```java
public Backend selectBackendForGroupCommit(long tableId, ConnectContext context, boolean isCloud)
        throws LoadException, DdlException {
    if (!Env.getCurrentEnv().isMaster()) {
        try {
            long backendId = new MasterOpExecutor(context)
                    .getGroupCommitLoadBeId(tableId, context.getCloudCluster(), isCloud);
            return Env.getCurrentSystemInfo().getBackend(backendId);
        } catch (Exception e) {
            throw new LoadException(e.getMessage());
        }
    } else {
        return Env.getCurrentSystemInfo()
                .getBackend(selectBackendForGroupCommitInternal(tableId, context.getCloudCluster(), isCloud));
    }
}
```

## Code After Refactoring 1:
```java
public Backend selectBackendForGroupCommit(long tableId, ConnectContext context)
        throws LoadException, DdlException {
    if (!Env.getCurrentEnv().isMaster()) {
        try {
            long backendId = new MasterOpExecutor(context)
                    .getGroupCommitLoadBeId(tableId, context.getCloudCluster());
            return Env.getCurrentSystemInfo().getBackend(backendId);
        } catch (Exception e) {
            throw new LoadException(e.getMessage());
        }
    } else {
        return Env.getCurrentSystemInfo()
                .getBackend(selectBackendForGroupCommitInternal(tableId, context.getCloudCluster()));
    }
}
```

## Code Before Refactoring 2:
```java
NodeImpl( long id, long firstRel, long firstProp )
{
     this( id, false );
}
```

## Code After Refactoring 2:
```java
NodeImpl( long id)
{
     this( id, false );
}
```

## Task

Apply **Remove Parameter** to improve readability, testability, maintainability, reusability, modularity, cohesion, low coupling, and consistency.

Always return a complete and compilable method (Java 17).

Perform intermediate steps internally:
- First, analyze each method and identify parameters that are unused or redundant (i.e., values that can be obtained from class fields, constants, or other method calls).
- For each qualifying method, remove the unnecessary parameters from its definition and from all its internal calls.
- Ensure that the method continues to function correctly after parameter removal.
- Output only the refactored code inside a single ```java``` block.
- Do not remove any functionality from the original method.
- Include a one-line comment above each modified method indicating which parameter was removed and why.

## Code to be Refactored:

Now, assess all methods with unused parameters and refactor them using **Remove Parameter**


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `java-refactoring-remove-parameter`: Refactoring using Remove Parameter in Java Language
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
