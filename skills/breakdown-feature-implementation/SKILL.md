---
name: breakdown-feature-implementation
description: 'Prompt for creating detailed feature implementation plans, following Epoch monorepo structure.'
triggers:
  - "breakdown-feature-implementation"
  - "breakdown feature implementation"
  - "awesome copilot breakdown feature implementation"
---

# Feature Implementation Plan Prompt

## Goal

Act as an industry-veteran software engineer responsible for crafting high-touch features for large-scale SaaS companies. Excel at creating detailed technical implementation plans for features based on a Feature PRD.
Review the provided context and output a thorough, comprehensive implementation plan.
**Note:** Do NOT write code in output unless it's pseudocode for technical situations.

## Output Format

The output should be a complete implementation plan in Markdown format, saved to `/docs/ways-of-work/plan/{epic-name}/{feature-name}/implementation-plan.md`.

### File System

Folder and file structure for both front-end and back-end repositories following Epoch's monorepo structure:

```
apps/
  [app-name]/
services/
  [service-name]/
packages/
  [package-name]/
```

### Implementation Plan

For each feature:

#### Goal

Feature goal described (3-5 sentences)

#### Requirements

- Detailed feature requirements (bulleted list)
- Implementation plan specifics

#### Technical Considerations

##### System Architecture Overview

Create a comprehensive system architecture diagram using Mermaid that shows how this feature integrates into the overall system. The diagram should include:

- **Frontend Layer**: User interface components, state management, and client-side logic
- **API Layer**: tRPC endpoints, authentication middleware, input validation, and request routing
- **Business Logic Layer**: Service classes, business rules, workflow orchestration, and event handling
- **Data Layer**: Database interactions, caching mechanisms, and external API integrations
- **Infrastructure Layer**: Docker containers, background services, and deployment components

Use subgraphs to organize these layers clearly. Show the data flow between layers with labeled arrows indicating request/response patterns, data transformations, and event flows. Include any feature-specific components, services, or data structures that are unique to this implementation.

- **Technology Stack Selection**: Document choice rationale for each layer
```

- **Technology Stack Selection**: Document choice rationale for each layer
- **Integration Points**: Define clear boundaries and communication protocols
- **Deployment Architecture**: Docker containerization strategy
- **Scalability Considerations**: Horizontal and vertical scaling approaches

##### Database Schema Design

Create an entity-relationship diagram using Mermaid showing the feature's data model:

- **Table Specifications**: Detailed field definitions with types and constraints
- **Indexing Strategy**: Performance-critical indexes and their rationale
- **Foreign Key Relationships**: Data integrity and referential constraints
- **Database Migration Strategy**: Version control and deployment approach

##### API Design

- Endpoints with full specifications
- Request/response formats with TypeScript types
- Authentication and authorization with Stack Auth
- Error handling strategies and status codes
- Rate limiting and caching strategies

##### Frontend Architecture

###### Component Hierarchy Documentation

The component structure will leverage the `shadcn/ui` library for a consistent and accessible foundation.

**Layout Structure:**

```
Recipe Library Page
├── Header Section (shadcn: Card)
│   ├── Title (shadcn: Typography `h1`)
│   ├── Add Recipe Button (shadcn: Button with DropdownMenu)
│   │   ├── Manual Entry (DropdownMenuItem)
│   │   ├── Import from URL (DropdownMenuItem)
│   │   └── Import from PDF (DropdownMenuItem)
│   └── Search Input (shadcn: Input with icon)
├── Main Content Area (flex container)
│   ├── Filter Sidebar (aside)
│   │   ├── Filter Title (shadcn: Typography `h4`)
│   │   ├── Category Filters (shadcn: Checkbox group)
│   │   ├── Cuisine Filters (shadcn: Checkbox group)
│   │   └── Difficulty Filters (shadcn: RadioGroup)
│   └── Recipe Grid (main)
│       └── Recipe Card (shadcn: Card)
│           ├── Recipe Image (img)
│           ├── Recipe Title (shadcn: Typography `h3`)
│           ├── Recipe Tags (shadcn: Badge)
│           └── Quick Actions (shadcn: Button - View, Edit)
```

- **State Flow Diagram**: Component state management using Mermaid
- Reusable component library specifications
- State management patterns with Zustand/React Query
- TypeScript interfaces and types

##### Security Performance

- Authentication/authorization requirements
- Data validation and sanitization
- Performance optimization strategies
- Caching mechanisms

## Context Template

- **Feature PRD:** [The content of the Feature PRD markdown file]


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `breakdown-feature-implementation`: Prompt for creating detailed feature implementation plans, following Epoch monorepo structure.
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
