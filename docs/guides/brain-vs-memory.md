# Brain vs Memory vs Session

## Goal
Know what goes in MBrain, what goes in agent memory, and what stays in session context -- so every piece of information lands in the right layer.

## What the User Gets
Without this: people dossiers get stored in agent memory (lost on agent reset), user preferences get stored in MBrain (cluttering knowledge pages), and the agent re-asks questions it already knows the answer to. With this: world knowledge persists in the brain, operational state persists in agent memory, and the agent never puts information in the wrong layer.

## Implementation

```
on new_information(info):
    # Three layers, three purposes -- route to the right one

    if info.is_about_the_world:
        # MBRAIN: people, companies, deals, meetings, concepts, ideas
        # This is world knowledge -- facts about entities external to the agent
        route_memory_writeback(info)
        # Direct canonical writes need router permission and a target snapshot.
        # If the signal becomes a Memory Inbox candidate with no target, review
        # its canonical target proposal before any page binding or promotion.
        # Examples:
        #   "Pedro is CEO of Brex"           -> mbrain (person page)
        #   "Brex raised Series D at $12B"   -> mbrain (company page)
        #   "Tuesday's meeting covered Q2"   -> mbrain (meeting page)
        #   "The meatsuit maintenance tax"   -> mbrain (originals page)

    elif info.is_about_operations:
        # AGENT MEMORY: preferences, decisions, tool config, session continuity
        # This is how the agent operates -- not facts about the world
        memory_write(info)
        # Examples:
        #   "User prefers concise formatting"      -> agent memory
        #   "Deploy to staging before prod"        -> agent memory
        #   "Use dark mode in code blocks"         -> agent memory
        #   "API key for Crustdata goes in .env"   -> agent memory

    elif info.is_current_conversation:
        # SESSION CONTEXT: what was just said, current task, immediate state
        # This is automatic -- already in the conversation window
        # No storage action needed
        # Examples:
        #   "We were just discussing the board deck"  -> session
        #   "You asked me to review this PR"          -> session
        #   "The file I just shared"                  -> session

# Lookup routing:
on user_asks(question):
    if question.about_person or question.about_company or question.about_meeting:
        mbrain search "{entity}"    # -> world knowledge
        mbrain get <slug>

    elif question.about_preference or question.about_how_to_operate:
        memory_search("{topic}")    # -> operational state

    elif question.about_current_context:
        # Already in session -- just reference conversation history
        pass
```

## Tricky Spots

1. **Don't store people in agent memory.** "Pedro prefers email over Slack" feels like a preference, but it's a fact about Pedro -- it goes in MBrain on Pedro's page. Agent memory is for the agent's own operational state, not facts about people in the world.
2. **Don't store user preferences in MBrain.** "User likes bullet points over paragraphs" is about how the agent should behave, not about the world. It goes in agent memory. MBrain pages are for entities, not for agent configuration.
3. **Synthesis of external ideas goes in MBrain.** "User's take on Peter Thiel's zero-to-one framework" is the user's original thinking -- it goes in MBrain under originals/, not in agent memory.
4. **Agent memory doesn't survive agent resets on some platforms.** Critical world knowledge MUST be in MBrain, which is durable. If the agent loses memory, the brain still has everything.
5. **A targetless candidate is not factual evidence.** Treat Memory Inbox candidates without canonical targets as review items only. First review the proposed canonical home, approve or reject that proposal, and bind only after approval. If the page is missing, create it through patch candidate review/apply; proposal approval itself must not write the page.
6. **When in doubt, ask: is this about the world or about how to operate?** World -> MBrain. Operations -> agent memory. Current conversation -> session.

## How to Verify

1. Ask the agent "Who is Pedro?" -- confirm it runs `mbrain search` or `mbrain get`, not `memory_search`. Person lookup should hit MBrain.
2. Ask the agent "How should I format responses?" -- confirm it checks agent memory, not MBrain. Preferences are operational state.
3. Check that no person or company pages exist in agent memory storage. Run `memory_search "person"` -- it should return preferences, not dossiers.
4. Check that MBrain doesn't contain pages about agent behavior. Run `mbrain search "user prefers"` -- it should return nothing (preferences belong in agent memory).
5. After an agent reset, confirm MBrain knowledge is still accessible. Run `mbrain get <any_slug>` -- world knowledge should survive the reset.
6. For a targetless Memory Inbox candidate, confirm the report asks for canonical target proposal review first; it should not use the candidate as answer evidence or call `put_page` during proposal approval.

---
*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md).*
