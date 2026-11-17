**Conversation extraction keeps wishes and preferences again: the extractor no longer asks the model for a slot on every fact.**

### Fixed
- Since 0.60.735.0, `gbrain extract-conversation-facts` asked the model for a slot (where a person lives, who employs them or their role) on every fact. That request made it save fewer facts, with wishes, preferences and ideas down about 15%. The main extraction call now sends the prompt and response shape it used before 0.60.735.0, so no new fact carries a slot. Facts already stored with a slot keep it, and the facts block still works out their validity windows. Re-extracting old pages with `--force` no longer adds slots, so skip the paid run the 0.60.735.0 notice suggested for them.

<!-- behavior-change: conversation_extraction_no_slot_gbra574 -->
