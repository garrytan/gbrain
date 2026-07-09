---
name: dotnet-timezone
description: '.NET timezone handling guidance for C# applications. Use when working with TimeZoneInfo, DateTimeOffset, NodaTime, UTC conversion, daylight saving time, scheduling across timezones, cross-platform Windows/IANA timezone IDs, or when a .NET user needs the timezone for a city, address, region, or country and copy-paste-ready C# code.'
triggers:
  - "dotnet-timezone"
  - "dotnet timezone"
  - "awesome copilot dotnet timezone"
---

# .NET Timezone

Resolve timezone questions for .NET and C# code with production-safe guidance and copy-paste-ready snippets.

## Start With The Right Path

Identify the request type first:

- Address or location lookup
- Timezone ID lookup
- UTC/local conversion
- Cross-platform timezone compatibility
- Scheduling or DST handling
- API or persistence design

If the library is unclear, default to `TimeZoneConverter` for cross-platform work. If the scenario involves recurring schedules or strict DST rules, prefer `NodaTime`.

## Resolve Addresses And Locations

If the user provides an address, city, region, country, or document containing place names:

1. Extract each location from the input.
2. Read `references/timezone-index.md` for common Windows and IANA mappings.
3. If the exact location is not listed, infer the correct IANA zone from geography, then map it to the Windows ID.
4. Return both IDs and a ready-to-use C# example.

For each resolved location, provide:

```text
Location: <resolved place>
Windows ID: <windows id>
IANA ID: <iana id>
UTC offset: <standard offset and DST offset when relevant>
DST: <yes/no>
```

Then include a cross-platform snippet like:

```csharp
using TimeZoneConverter;

TimeZoneInfo tz = TZConvert.GetTimeZoneInfo("Asia/Colombo");
DateTime local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz);
```

If multiple locations are present, include one block per location and then a combined multi-timezone snippet.

If a location is ambiguous, list the possible timezone matches and ask the user to choose the correct one.

## Look Up Timezone IDs

Use `references/timezone-index.md` for Windows to IANA mappings.

Always provide both formats:

- Windows ID for `TimeZoneInfo.FindSystemTimeZoneById()` on Windows
- IANA ID for Linux, containers, `NodaTime`, and `TimeZoneConverter`

## Generate Code

Use `references/code-patterns.md` and pick the smallest pattern that fits:

- Pattern 1: `TimeZoneInfo` for Windows-only code
- Pattern 2: `TimeZoneConverter` for cross-platform conversion
- Pattern 3: `NodaTime` for strict timezone arithmetic and DST-sensitive scheduling
- Pattern 4: `DateTimeOffset` for APIs and data transfer
- Pattern 5: ASP.NET Core persistence and presentation
- Pattern 6: recurring jobs and schedulers
- Pattern 7: ambiguous and invalid DST timestamps

Always include package guidance when recommending third-party libraries.

## Warn About Common Pitfalls

Mention the relevant warning when applicable:

- `TimeZoneInfo.FindSystemTimeZoneById()` is platform-specific for timezone IDs.
- Avoid storing `DateTime.Now` in databases; store UTC instead.
- Treat `DateTimeKind.Unspecified` as a bug risk unless it is deliberate input.
- DST transitions can skip or repeat local times.
- Azure Windows and Azure Linux environments may expect different timezone ID formats.

## Response Shape

For address and location requests:

1. Return the resolved timezone block for each location.
2. State the recommended implementation in one sentence.
3. Include a copy-paste-ready C# snippet.

For code and architecture requests:

1. State the recommended approach in one sentence.
2. Provide the timezone IDs if relevant.
3. Include the minimal working code snippet.
4. Mention the package requirement if needed.
5. Add one pitfall warning if it matters.

Keep responses concise and code-first.

## References

- `references/timezone-index.md`: common Windows and IANA timezone mappings
- `references/code-patterns.md`: ready-to-use .NET timezone patterns


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `dotnet-timezone`: .NET timezone handling guidance for C# applications. Use when working with TimeZoneInfo, DateTimeOffset, NodaTime, UTC conversion, daylight saving time, scheduling across timezones, cross-platform Windows/IANA timezone I
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
