---
title: "GLP-1 medications doses"
type: guide
created: 2025-11-23
updated: 2025-11-23
source: chatgpt-export
conversation_id: 692330b8-e454-832d-84b8-6bef890d93e0
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# GLP-1 medications doses

> Conversation ID: 692330b8-e454-832d-84b8-6bef890d93e0
> Created: 2025-11-23T16:05:55Z
> Updated: 2025-11-23T16:10:42Z
> Messages: 4

---

## User

I need a json object with all the major glp-1 medication and the doses that can be prescribed. Include compounded medication and the ingredients they are compounded with from providers like mochi health etc

---

## Assistant

Mr. White, below is a single JSON object covering major FDA-approved GLP-1 (and dual GIP/GLP-1) meds with prescribable dose strengths and typical titration, plus commonly seen compounded semaglutide/tirzepatide variants and additives. FDA-approved doses come from current US prescribing info for each product. citeturn0search1turn1search8turn1search1turn0search2turn0search5turn1search2turn2search0turn1search11turn2search12turn2search5turn2search6turn4search2turn4search1  
Compounded GLP-1s are not FDA-approved; formulations and additives vary by pharmacy/provider, and you should verify what’s in a specific vial. Mochi and similar telehealth clinics note additives may be present (often B12), but exact ingredients depend on the compounding pharmacy. citeturn3search0turn3search3  
Important safety/legal note: FDA warns some compounders use semaglutide *salt forms* (semaglutide sodium/acetate), which are different active ingredients and lack a lawful basis for compounding. citeturn0search0turn0search6turn0search10  

```json
{
  "fda_approved": [
    {
      "generic": "semaglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Wegovy",
          "indication": "chronic weight management; also used for obesity-related conditions",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.25, 0.5, 1.0, 1.7, 2.4],
          "typical_adult_titration_mg_per_week": [
            { "weeks": "1-4", "dose_mg": 0.25 },
            { "weeks": "5-8", "dose_mg": 0.5 },
            { "weeks": "9-12", "dose_mg": 1.0 },
            { "weeks": "13-16", "dose_mg": 1.7 },
            { "weeks": "17+", "dose_mg": 2.4 }
          ],
          "maintenance_mg_per_week_options": [1.7, 2.4]
        },
        {
          "name": "Ozempic",
          "indication": "type 2 diabetes; CV risk reduction in T2D with established CVD",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.25, 0.5, 1.0, 2.0],
          "typical_adult_titration_mg_per_week": [
            { "weeks": "1-4", "dose_mg": 0.25 },
            { "weeks": "5-8", "dose_mg": 0.5 },
            { "weeks": "9+", "dose_mg_options": [1.0, 2.0] }
          ]
        },
        {
          "name": "Rybelsus",
          "indication": "type 2 diabetes",
          "route": "oral",
          "frequency": "once daily",
          "prescribable_strengths_mg": [3, 7, 14],
          "typical_adult_titration_mg_per_day": [
            { "days": "1-30", "dose_mg": 3 },
            { "day": "31+", "dose_mg_options": [7, 14] }
          ]
        }
      ]
    },
    {
      "generic": "tirzepatide",
      "class": "dual GIP/GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Mounjaro",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.5, 5, 7.5, 10, 12.5, 15],
          "typical_adult_titration_mg_per_week": [
            { "weeks": "1-4", "dose_mg": 2.5 },
            { "weeks": "5-8", "dose_mg": 5 },
            { "weeks": "9-12", "dose_mg": 7.5 },
            { "weeks": "13-16", "dose_mg": 10 },
            { "weeks": "17-20", "dose_mg": 12.5 },
            { "weeks": "21+", "dose_mg": 15 }
          ],
          "maintenance_mg_per_week_options": [5, 10, 15]
        },
        {
          "name": "Zepbound",
          "indication": "chronic weight management",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.5, 5, 7.5, 10, 12.5, 15],
          "typical_adult_titration_mg_per_week": [
            { "weeks": "1-4", "dose_mg": 2.5 },
            { "weeks": "5-8", "dose_mg": 5 },
            { "weeks": "9-12", "dose_mg": 7.5 },
            { "weeks": "13-16", "dose_mg": 10 },
            { "weeks": "17-20", "dose_mg": 12.5 },
            { "weeks": "21+", "dose_mg": 15 }
          ],
          "maintenance_mg_per_week_options": [5, 10, 15]
        }
      ]
    },
    {
      "generic": "liraglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Saxenda",
          "indication": "chronic weight management",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mg": [0.6, 1.2, 1.8, 2.4, 3.0],
          "typical_adult_titration_mg_per_day": [
            { "week": 1, "dose_mg": 0.6 },
            { "week": 2, "dose_mg": 1.2 },
            { "week": 3, "dose_mg": 1.8 },
            { "week": 4, "dose_mg": 2.4 },
            { "week": 5, "dose_mg": 3.0 }
          ],
          "maintenance_mg_per_day": 3.0
        },
        {
          "name": "Victoza",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mg": [0.6, 1.2, 1.8],
          "typical_adult_titration_mg_per_day": [
            { "week": 1, "dose_mg": 0.6 },
            { "week": "2+", "dose_mg_options": [1.2, 1.8] }
          ]
        }
      ]
    },
    {
      "generic": "dulaglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Trulicity",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.75, 1.5, 3.0, 4.5],
          "titration_note": "increase after at least 4 weeks on current dose if needed",
          "maintenance_mg_per_week_range": [0.75, 4.5]
        }
      ]
    },
    {
      "generic": "exenatide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Byetta",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "twice daily",
          "prescribable_strengths_mcg": [5, 10],
          "typical_adult_titration_mcg_per_dose": [
            { "month": 1, "dose_mcg": 5 },
            { "month": "2+", "dose_mcg": 10 }
          ]
        },
        {
          "name": "Bydureon BCise",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.0]
        }
      ]
    },
    {
      "generic": "lixisenatide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Adlyxin",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mcg": [10, 20],
          "typical_adult_titration_mcg_per_day": [
            { "days": "1-14", "dose_mcg": 10 },
            { "day": "15+", "dose_mcg": 20 }
          ]
        }
      ]
    },
    {
      "generic": "fixed-dose combinations (contain a GLP-1 RA)",
      "brands": [
        {
          "name": "Soliqua 100/33",
          "ingredients": ["insulin glargine", "lixisenatide"],
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_dose_range_units_per_day": [15, 60],
          "per_unit_contents": {
            "insulin_glargine_units": 1,
            "lixisenatide_mcg": 0.33
          }
        },
        {
          "name": "Xultophy 100/3.6",
          "ingredients": ["insulin degludec", "liraglutide"],
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_dose_range_units_per_day": [10, 50],
          "per_unit_contents": {
            "insulin_degludec_units": 1,
            "liraglutide_mg": 0.036
          }
        }
      ]
    }
  ],
  "compounded": [
    {
      "generic": "semaglutide (compounded)",
      "active_form_should_be": "semaglutide base",
      "not_recommended_active_forms": [
        "semaglutide sodium",
        "semaglutide acetate"
      ],
      "custom_strengths_mg_per_mL": "varies by compounding pharmacy",
      "commonly_compounded_with": [
        {
          "ingredient": "cyanocobalamin (vitamin B12)",
          "notes": "common additive; may tint solution pink/red"
        },
        {
          "ingredient": "glycine",
          "notes": "added by some pharmacies"
        },
        {
          "ingredient": "pyridoxine (vitamin B6)",
          "notes": "occasionally added"
        },
        {
          "ingredient": "L-carnitine",
          "notes": "occasionally added"
        },
        {
          "ingredient": "NAD+ (nicotinamide adenine dinucleotide)",
          "notes": "occasionally added"
        }
      ],
      "provider_note": "telehealth providers (e.g., Mochi Health) may use different additives; check your vial label/portal for exact ingredients"
    },
    {
      "generic": "tirzepatide (compounded)",
      "active_form_should_be": "tirzepatide base",
      "custom_strengths_mg_per_mL": "varies by compounding pharmacy",
      "commonly_compounded_with": [
        {
          "ingredient": "cyanocobalamin (vitamin B12)",
          "notes": "used by some compounders"
        },
        {
          "ingredient": "other B-complex vitamins",
          "notes": "used by some compounders"
        }
      ],
      "provider_note": "availability and legality of compounded tirzepatide copies varies as FDA shortage status changes"
    }
  ],
  "regulatory_warnings": {
    "compounded_glp1_not_fda_approved": true,
    "note": "FDA warns that compounded GLP-1 products may have dosing/quality issues, and salt forms of semaglutide are not considered lawful for compounding."
  }
}
```

---

## User

Remove weeks and fad approved object.

---

## Assistant

```json
{
  "major_glp1_and_related_medications": [
    {
      "generic": "semaglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Wegovy",
          "indication": "chronic weight management",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.25, 0.5, 1.0, 1.7, 2.4],
          "typical_titration_sequence_mg_per_week": [0.25, 0.5, 1.0, 1.7, 2.4],
          "maintenance_mg_per_week_options": [1.7, 2.4]
        },
        {
          "name": "Ozempic",
          "indication": "type 2 diabetes; CV risk reduction in T2D with established CVD",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.25, 0.5, 1.0, 2.0],
          "typical_titration_sequence_mg_per_week": [0.25, 0.5, 1.0, 2.0]
        },
        {
          "name": "Rybelsus",
          "indication": "type 2 diabetes",
          "route": "oral",
          "frequency": "once daily",
          "prescribable_strengths_mg": [3, 7, 14],
          "typical_titration_sequence_mg_per_day": [3, 7, 14]
        }
      ]
    },
    {
      "generic": "tirzepatide",
      "class": "dual GIP/GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Mounjaro",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.5, 5, 7.5, 10, 12.5, 15],
          "typical_titration_sequence_mg_per_week": [2.5, 5, 7.5, 10, 12.5, 15],
          "maintenance_mg_per_week_options": [5, 10, 15]
        },
        {
          "name": "Zepbound",
          "indication": "chronic weight management",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.5, 5, 7.5, 10, 12.5, 15],
          "typical_titration_sequence_mg_per_week": [2.5, 5, 7.5, 10, 12.5, 15],
          "maintenance_mg_per_week_options": [5, 10, 15]
        }
      ]
    },
    {
      "generic": "liraglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Saxenda",
          "indication": "chronic weight management",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mg": [0.6, 1.2, 1.8, 2.4, 3.0],
          "typical_titration_sequence_mg_per_day": [0.6, 1.2, 1.8, 2.4, 3.0],
          "maintenance_mg_per_day": 3.0
        },
        {
          "name": "Victoza",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mg": [0.6, 1.2, 1.8],
          "typical_titration_sequence_mg_per_day": [0.6, 1.2, 1.8]
        }
      ]
    },
    {
      "generic": "dulaglutide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Trulicity",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [0.75, 1.5, 3.0, 4.5],
          "typical_titration_sequence_mg_per_week": [0.75, 1.5, 3.0, 4.5]
        }
      ]
    },
    {
      "generic": "exenatide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Byetta",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "twice daily",
          "prescribable_strengths_mcg": [5, 10],
          "typical_titration_sequence_mcg_per_dose": [5, 10]
        },
        {
          "name": "Bydureon BCise",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once weekly",
          "prescribable_strengths_mg": [2.0]
        }
      ]
    },
    {
      "generic": "lixisenatide",
      "class": "GLP-1 receptor agonist",
      "brands": [
        {
          "name": "Adlyxin",
          "indication": "type 2 diabetes",
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_strengths_mcg": [10, 20],
          "typical_titration_sequence_mcg_per_day": [10, 20]
        }
      ]
    },
    {
      "generic": "fixed-dose combinations containing GLP-1 RA",
      "brands": [
        {
          "name": "Soliqua 100/33",
          "ingredients": ["insulin glargine", "lixisenatide"],
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_dose_range_units_per_day": [15, 60],
          "per_unit_contents": {
            "insulin_glargine_units": 1,
            "lixisenatide_mcg": 0.33
          }
        },
        {
          "name": "Xultophy 100/3.6",
          "ingredients": ["insulin degludec", "liraglutide"],
          "route": "subcutaneous",
          "frequency": "once daily",
          "prescribable_dose_range_units_per_day": [10, 50],
          "per_unit_contents": {
            "insulin_degludec_units": 1,
            "liraglutide_mg": 0.036
          }
        }
      ]
    }
  ],
  "compounded_glp1": [
    {
      "generic": "semaglutide (compounded)",
      "active_form_should_be": "semaglutide base",
      "not_recommended_active_forms": ["semaglutide sodium", "semaglutide acetate"],
      "custom_strengths_mg_per_mL": "varies by compounding pharmacy",
      "commonly_compounded_with": [
        { "ingredient": "cyanocobalamin (vitamin B12)", "notes": "most common additive" },
        { "ingredient": "glycine", "notes": "added by some pharmacies" },
        { "ingredient": "pyridoxine (vitamin B6)", "notes": "occasionally added" },
        { "ingredient": "L-carnitine", "notes": "occasionally added" },
        { "ingredient": "NAD+", "notes": "occasionally added" }
      ],
      "provider_note": "telehealth providers (e.g., Mochi Health) may use different additives depending on the pharmacy; verify vial label for exact ingredients"
    },
    {
      "generic": "tirzepatide (compounded)",
      "active_form_should_be": "tirzepatide base",
      "custom_strengths_mg_per_mL": "varies by compounding pharmacy",
      "commonly_compounded_with": [
        { "ingredient": "cyanocobalamin (vitamin B12)", "notes": "common additive" },
        { "ingredient": "other B-complex vitamins", "notes": "used by some compounders" }
      ],
      "provider_note": "availability and legality of compounded tirzepatide may change with FDA shortage status"
    }
  ],
  "regulatory_warnings": {
    "compounded_products_not_fda_approved": true,
    "note": "FDA warns compounded GLP-1 products may vary in quality/dosing and that semaglutide salt forms are not considered lawful for compounding."
  }
}
```


## See Also
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_1001tracklisting-search-query]]
