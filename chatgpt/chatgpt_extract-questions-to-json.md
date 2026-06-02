---
title: "Extract Questions to JSON"
type: guide
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a06280f-5834-83e8-957f-9b6d1c8baeaa
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Extract Questions to JSON

> Conversation ID: 6a06280f-5834-83e8-957f-9b6d1c8baeaa
> Created: 2026-05-14T19:52:48Z
> Updated: 2026-05-14T20:00:41Z
> Messages: 3

---

## User

extract eEvery question on this page to JSON Include all optional ones and all context and all character limits and everything for each question. 

---

## Assistant

I’ll convert the visible form into structured JSON, preserving sections, labels, requirement status, helper text, input types, options, current values, and visible word/file limits.

---

## Assistant

Mr. White, extracted from the visible page context. The page exposes word limits/counters, not character limits.

```json
{
  "source": {
    "page_url": "https://speedrun.a16z.com/apply/form",
    "page_title_or_context": "a16z Speedrun application form",
    "extraction_scope": "visible browser page context only",
    "notes": [
      "Required fields are marked with an asterisk (*) on the page.",
      "The visible text shows word limits/counters, not character limits.",
      "Blank current_value means the page showed an empty input."
    ],
    "steps_visible": [
      "1. Team",
      "2. Startup Details",
      "3. Additional Information",
      "3. Additional Information"
    ]
  },
  "sections": [
    {
      "section": "Team",
      "context": "We back exceptional founders. Tell us who’s building this and why you’re the team to make it happen.",
      "required_fields_note": "Required fields are marked with an asterisk (*).",
      "questions": [
        {
          "id": "team_001",
          "question": "Are you full-time or part-time on the startup?",
          "required": true,
          "input_type": "radio",
          "options": [
            {
              "label": "Full-time",
              "selected": true
            },
            {
              "label": "Part-time",
              "selected": false
            }
          ],
          "current_value": "Full-time",
          "context": null,
          "limits": null
        },
        {
          "id": "team_002",
          "question": "Number of Full-Time Founders",
          "required": true,
          "input_type": "radio",
          "helper_text": "How many founders are working full-time on your startup?",
          "context": "Founders are individuals with over 10% equity. If you’re part-time or not yet incorporated, enter ‘0’ and add all co-founders in the section below.",
          "options": [
            {
              "label": "0",
              "selected": false
            },
            {
              "label": "1",
              "selected": true
            },
            {
              "label": "2",
              "selected": false
            },
            {
              "label": "3",
              "selected": false
            },
            {
              "label": "4",
              "selected": false
            },
            {
              "label": "5",
              "selected": false
            }
          ],
          "current_value": "1",
          "limits": null
        },
        {
          "id": "team_003",
          "question": "Total FTE Employees",
          "required": true,
          "input_type": "number",
          "field_label": "Full-Time Equivalent (FTE)",
          "field_required": true,
          "helper_text": "How many full-time equivalent employees (including founders) are currently at your startup?",
          "context": "Part-time staff should be counted proportionally (e.g., two half-time employees = 1 FTE).",
          "current_value": "",
          "limits": null
        },
        {
          "id": "team_004",
          "question": "Founder Details",
          "required": true,
          "input_type": "group",
          "helper_text": "Tell us who’s building this. Start with the CEO, then add any co-founders.",
          "current_group": "CEO",
          "fields": [
            {
              "field_label": "first name",
              "required": true,
              "input_type": "text",
              "current_value": "Tim",
              "limits": null
            },
            {
              "field_label": "last name",
              "required": true,
              "input_type": "text",
              "current_value": "White",
              "limits": null
            },
            {
              "field_label": "email",
              "required": true,
              "input_type": "email",
              "current_value": "tim@jov.ie",
              "limits": null
            },
            {
              "field_label": "phone number",
              "required": false,
              "input_type": "tel",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "Relevant experience",
              "required": true,
              "input_type": "textarea",
              "subfield_label": "Founder experience",
              "helper_text": "In a few sentences, highlight your most relevant professional, startup, or industry experience. Focus on track record, domain expertise, and past wins.",
              "current_value": "15+ years in music spanning releases, songwriting, production, digital marketing, and brand consulting. Credits include Universal, Sony, Google, Netflix, Hulu, NFL, and NBA All-Star Game. Drove 90M+ streams and grew an audience to 191K Instagram followers.",
              "limits": {
                "type": "words",
                "current_count": 36,
                "max": 100,
                "counter_text": "36 / 100 words"
              }
            },
            {
              "field_label": "country",
              "required": true,
              "input_type": "select/search",
              "current_value": "US",
              "selected_display_value": "United States of America",
              "limits": null
            },
            {
              "field_label": "State",
              "required": true,
              "input_type": "select/search",
              "current_value": "California",
              "selected_display_value": "California",
              "limits": null
            },
            {
              "field_label": "City",
              "required": true,
              "input_type": "text",
              "current_value": "Los Angeles",
              "limits": null
            },
            {
              "field_label": "Citizenship",
              "required": true,
              "input_type": "select/search",
              "current_value": "US",
              "selected_display_value": "United States of America",
              "limits": null
            },
            {
              "field_label": "College / University",
              "required": true,
              "input_type": "text",
              "current_value": "Drexel University",
              "limits": null
            },
            {
              "field_label": "Highest education",
              "required": false,
              "input_type": "select/search",
              "current_value": "High School Degree",
              "selected_display_value": "High School Degree",
              "limits": null
            },
            {
              "field_label": "How many years of professional experience do you have?",
              "required": true,
              "input_type": "number",
              "subfield_label": "years of experience",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "Are you technical enough to build the product end-to-end?",
              "required": true,
              "input_type": "radio",
              "options": [
                {
                  "label": "Yes",
                  "selected": true
                },
                {
                  "label": "No",
                  "selected": false
                }
              ],
              "current_value": "Yes",
              "limits": null
            },
            {
              "field_label": "LinkedIn url",
              "required": true,
              "input_type": "url",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "github url",
              "required": false,
              "input_type": "url",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "x url",
              "required": false,
              "input_type": "url",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "portfolio url",
              "required": false,
              "input_type": "text",
              "helper_text": "Link to personal website, project portfolio, or side project.",
              "current_value": "",
              "limits": null
            }
          ],
          "actions": [
            {
              "label": "add co-founder",
              "type": "button"
            }
          ]
        },
        {
          "id": "team_005",
          "question": "Tell us more about the team",
          "required": true,
          "input_type": "textarea",
          "field_label": "Team description",
          "field_required": true,
          "helper_text": "How does the team know each other? Is there anyone else on the team? Why is this the best team to win? Do you have any key advisors? Etc",
          "current_value": "",
          "limits": {
            "type": "words",
            "current_count": 0,
            "max": 100,
            "counter_text": "0 / 100 words"
          }
        }
      ]
    },
    {
      "section": "Startup Details",
      "context": "Help us understand your startup. The problem you're solving, your solution, and where you are today.",
      "required_fields_note": "Required fields are marked with an asterisk (*).",
      "questions": [
        {
          "id": "startup_001",
          "question": "Startup Name",
          "required": true,
          "input_type": "text",
          "field_label": "startup name",
          "field_required": true,
          "current_value": "",
          "limits": null
        },
        {
          "id": "startup_002",
          "question": "Pitch your startup in one sentence.",
          "required": true,
          "input_type": "text",
          "field_label": "One-liner",
          "field_required": true,
          "helper_text": "What do you do and for whom? E.g. “AI-powered therapist for Gen Z”",
          "current_value": "",
          "limits": {
            "type": "words",
            "current_count": 0,
            "max": 10,
            "counter_text": "0/10 words"
          }
        },
        {
          "id": "startup_003",
          "question": "Startup Description",
          "required": true,
          "input_type": "textarea",
          "field_label": "startup description",
          "field_required": true,
          "helper_text": "What problem are you solving? What are you building?",
          "current_value": "",
          "limits": {
            "type": "words",
            "current_count": 0,
            "max": 100,
            "counter_text": "0/100 words"
          }
        },
        {
          "id": "startup_004",
          "question": "Primary Category",
          "required": true,
          "input_type": "radio",
          "helper_text": "Select the closest match for your startup. If none apply, choose 'Other'.",
          "options": [
            {
              "label": "B2B / Enterprise Applications",
              "selected": false
            },
            {
              "label": "Consumer Applications",
              "selected": false
            },
            {
              "label": "Deep Tech",
              "selected": false
            },
            {
              "label": "Gaming / Entertainment Studio",
              "selected": false
            },
            {
              "label": "Infrastructure / Dev Tools",
              "selected": false
            },
            {
              "label": "Healthcare",
              "selected": false
            },
            {
              "label": "GovTech",
              "selected": false
            },
            {
              "label": "Crypto",
              "selected": false
            },
            {
              "label": "Other",
              "selected": false
            }
          ],
          "current_value": "",
          "limits": null
        },
        {
          "id": "startup_005",
          "question": "Secondary Category",
          "required": false,
          "input_type": "checkbox_group",
          "label_note": "optional",
          "helper_text": "If your startup fits more than one category, select a second category. If none apply, choose 'Other'.",
          "options": [
            {
              "label": "B2B / Enterprise Applications",
              "selected": false
            },
            {
              "label": "Consumer Applications",
              "selected": false
            },
            {
              "label": "Deep Tech",
              "selected": false
            },
            {
              "label": "Gaming / Entertainment Studio",
              "selected": false
            },
            {
              "label": "Infrastructure / Dev Tools",
              "selected": false
            },
            {
              "label": "Healthcare",
              "selected": false
            },
            {
              "label": "GovTech",
              "selected": false
            },
            {
              "label": "Crypto",
              "selected": false
            },
            {
              "label": "Other",
              "selected": false
            }
          ],
          "current_value": [],
          "limits": null
        },
        {
          "id": "startup_006",
          "question": "Where do you intend to build your startup?",
          "required": true,
          "input_type": "group",
          "fields": [
            {
              "field_label": "Country",
              "required": true,
              "input_type": "select/search",
              "current_value": "",
              "selected_display_value": "",
              "limits": null
            },
            {
              "field_label": "City",
              "required": true,
              "input_type": "text",
              "current_value": "",
              "limits": null
            }
          ]
        },
        {
          "id": "startup_007",
          "question": "When was your startup founded?",
          "required": true,
          "input_type": "group",
          "fields": [
            {
              "field_label": "year",
              "required": true,
              "input_type": "select/search",
              "current_value": "",
              "selected_display_value": "",
              "limits": null
            },
            {
              "field_label": "month",
              "required": true,
              "input_type": "select/search",
              "current_value": "",
              "selected_display_value": "",
              "limits": null
            }
          ]
        },
        {
          "id": "startup_008",
          "question": "Company Website",
          "required": false,
          "label_note": "optional",
          "input_type": "text",
          "field_label": "website url",
          "helper_text": "E.g. https://yourcompany.com",
          "current_value": "",
          "limits": null
        },
        {
          "id": "startup_009",
          "question": "Anything else we should know?",
          "required": false,
          "label_note": "optional",
          "input_type": "text",
          "field_label": "Additional information",
          "helper_text": "If there’s something that doesn’t fit elsewhere, drop it here.",
          "current_value": "",
          "limits": {
            "type": "words",
            "current_count": 0,
            "max": 100,
            "counter_text": "0 / 100 words"
          }
        }
      ]
    },
    {
      "section": "Additional Information",
      "context": "Show Us More. Any additional information you share with us adds important context that we review and significantly improves the strength of your application. Please share these below.",
      "questions": [
        {
          "id": "additional_001",
          "question": "Pitch Deck (PDF)",
          "required": false,
          "label_note": "Optional",
          "input_type": "checkbox_module_with_file_upload",
          "checked": true,
          "helper_text": "Upload your latest deck. PDF format only.",
          "upload": {
            "input_type": "file",
            "button_text": "Click to upload",
            "dropzone_text": "Click to upload or drag and drop",
            "accepted_format": "PDF",
            "max_file_size": "500MB",
            "current_value": ""
          },
          "limits": {
            "type": "file",
            "accepted_format": "PDF",
            "max_file_size": "500MB",
            "counter_text": "PDF (MAX. 500MB)"
          }
        },
        {
          "id": "additional_002",
          "question": "Traction",
          "required": false,
          "label_note": "Optional",
          "input_type": "checkbox_module",
          "checked": false,
          "helper_text": null,
          "fields_visible": []
        },
        {
          "id": "additional_003",
          "question": "Funding History",
          "required": false,
          "label_note": "Optional",
          "input_type": "checkbox_module",
          "checked": true,
          "helper_text": "Give us a quick snapshot of your fundraising to date.",
          "required_fields_note": "Required fields are marked with an asterisk (*).",
          "subsections": [
            {
              "subsection": "Funding Summary",
              "context": "Provide a few high-level details about your current funding situation.",
              "fields": [
                {
                  "field_label": "Total Funding Raised (USD)",
                  "required": false,
                  "input_type": "number",
                  "helper_text": "How much capital have you raised in total so far?",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "Post-Money Valuation (USD)",
                  "required": false,
                  "input_type": "number",
                  "helper_text": "After your last round closed.",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "When did you raise your last round / investment?",
                  "required": true,
                  "input_type": "date",
                  "subfield_label": "date",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "Monthly Burn Rate (USD)",
                  "required": false,
                  "input_type": "number",
                  "helper_text": "How much are you spending monthly?",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "Runway (months)",
                  "required": false,
                  "input_type": "number",
                  "helper_text": "How many months until you run out of money at your current burn?",
                  "current_value": "",
                  "limits": null
                }
              ]
            },
            {
              "subsection": "List your current investors",
              "required": true,
              "context": "Please list your major investors. This helps us contact them for a reference check if necessary.",
              "fields": [
                {
                  "field_label": "Investor 1 name or firm",
                  "required": true,
                  "input_type": "text",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "Investor 1 email",
                  "required": true,
                  "input_type": "email",
                  "current_value": "",
                  "limits": null
                },
                {
                  "field_label": "Investor 1 amount raised (USD)",
                  "required": false,
                  "input_type": "number",
                  "current_value": "",
                  "limits": null
                }
              ],
              "actions": [
                {
                  "label": "add another investor",
                  "type": "button"
                }
              ]
            }
          ]
        },
        {
          "id": "additional_004",
          "question": "Active Fundraising Round",
          "required": false,
          "label_note": "Optional",
          "input_type": "checkbox_module",
          "checked": true,
          "helper_text": "Provide details about your current fundraising round.",
          "required_fields_note": "Required fields are marked with an asterisk (*).",
          "fields": [
            {
              "field_label": "How much are you raising?",
              "required": true,
              "input_type": "number",
              "subfield_label": "Target amount (USD)",
              "helper_text": "Target amount for this round (USD).",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "When did you start your fundraise?",
              "required": true,
              "input_type": "date",
              "subfield_label": "start date",
              "current_value": "",
              "limits": null
            },
            {
              "field_label": "Are there any fundraising deadlines we should be aware of?",
              "required": false,
              "label_note": "optional",
              "input_type": "text",
              "subfield_label": "target date description",
              "current_value": "",
              "limits": null
            }
          ]
        },
        {
          "id": "additional_005",
          "question": "Referral",
          "required": false,
          "label_note": "Optional",
          "input_type": "checkbox_module",
          "checked": false,
          "fields": [
            {
              "field_label": "Where did you learn about speedrun?",
              "required": true,
              "required_text": "Required",
              "input_type": "select/search",
              "subfield_label": "source",
              "helper_text": "Let us know how you found out about speedrun. X, event, friend, etc.",
              "current_value": "",
              "selected_display_value": "",
              "limits": null
            },
            {
              "field_label": "additional info",
              "required": false,
              "label_note": "optional",
              "input_type": "text",
              "helper_text": "Provide the name, handle, post, event, etc.",
              "current_value": "",
              "limits": null
            }
          ]
        }
      ],
      "actions": [
        {
          "label": "submit application",
          "type": "button"
        }
      ]
    }
  ]
}
```
