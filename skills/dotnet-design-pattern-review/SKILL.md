---
name: dotnet-design-pattern-review
description: 'Review the C#/.NET code for design pattern implementation and suggest improvements.'
triggers:
  - "dotnet-design-pattern-review"
  - "dotnet design pattern review"
  - "awesome copilot dotnet design pattern review"
---

# .NET/C# Design Pattern Review

Review the C#/.NET code in ${selection} for design pattern implementation and suggest improvements for the solution/project. Do not make any changes to the code, just provide a review.

## Required Design Patterns

- **Command Pattern**: Generic base classes (`CommandHandler<TOptions>`), `ICommandHandler<TOptions>` interface, `CommandHandlerOptions` inheritance, static `SetupCommand(IHost host)` methods
- **Factory Pattern**: Complex object creation service provider integration
- **Dependency Injection**: Primary constructor syntax, `ArgumentNullException` null checks, interface abstractions, proper service lifetimes
- **Repository Pattern**: Async data access interfaces provider abstractions for connections
- **Provider Pattern**: External service abstractions (database, AI), clear contracts, configuration handling
- **Resource Pattern**: ResourceManager for localized messages, separate .resx files (LogMessages, ErrorMessages)

## Review Checklist

- **Design Patterns**: Identify patterns used. Are Command Handler, Factory, Provider, and Repository patterns correctly implemented? Missing beneficial patterns?
- **Architecture**: Follow namespace conventions (`{Core|Console|App|Service}.{Feature}`)? Proper separation between Core/Console projects? Modular and readable?
- **.NET Best Practices**: Primary constructors, async/await with Task returns, ResourceManager usage, structured logging, strongly-typed configuration?
- **GoF Patterns**: Command, Factory, Template Method, Strategy patterns correctly implemented?
- **SOLID Principles**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion violations?
- **Performance**: Proper async/await, resource disposal, ConfigureAwait(false), parallel processing opportunities?
- **Maintainability**: Clear separation of concerns, consistent error handling, proper configuration usage?
- **Testability**: Dependencies abstracted via interfaces, mockable components, async testability, AAA pattern compatibility?
- **Security**: Input validation, secure credential handling, parameterized queries, safe exception handling?
- **Documentation**: XML docs for public APIs, parameter/return descriptions, resource file organization?
- **Code Clarity**: Meaningful names reflecting domain concepts, clear intent through patterns, self-explanatory structure?
- **Clean Code**: Consistent style, appropriate method/class size, minimal complexity, eliminated duplication?

## Improvement Focus Areas

- **Command Handlers**: Validation in base class, consistent error handling, proper resource management
- **Factories**: Dependency configuration, service provider integration, disposal patterns
- **Providers**: Connection management, async patterns, exception handling and logging
- **Configuration**: Data annotations, validation attributes, secure sensitive value handling
- **AI/ML Integration**: Semantic Kernel patterns, structured output handling, model configuration

Provide specific, actionable recommendations for improvements aligned with the project's architecture and .NET best practices.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `dotnet-design-pattern-review`: Review the C#/.NET code for design pattern implementation and suggest improvements.
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
