---
title: "BodySpec JSON example"
type: guide
created: 2025-11-08
updated: 2025-11-08
source: chatgpt-export
conversation_id: 690fc289-42d4-8325-98a5-1294c616178c
message_count: 2
tags: [chatgpt, import, code]
---
# BodySpec JSON example

> Conversation ID: 690fc289-42d4-8325-98a5-1294c616178c
> Created: 2025-11-08T22:22:40Z
> Updated: 2025-11-08T22:22:59Z
> Messages: 2

---

## User

parse the specs here and give me an example json object of all the data we can get that is relevant for our log your body app that combines dexa scans with weight logs and progress photos to create a unified timeline.

---

## Assistant

Excellent — the BodySpec API docs you highlighted describe all models and endpoints we can query, so here’s a **composite JSON schema** that combines everything relevant for a “Log Your Body” app.  

The goal: unify **DEXA scan results**, **body composition**, **bone density**, **visceral fat**, **percentiles**, **appointments**, and **user metadata** — so you can integrate this into your weight logs and photo-based progress tracking timeline.

---

### ✅ Example Unified JSON Object

```json
{
  "user": {
    "user_id": "u_123456",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "phone": "+14155551234"
  },
  "timeline": [
    {
      "event_type": "weight_log",
      "date_time": "2025-11-01T07:00:00-08:00",
      "weight_kg": 92.3,
      "notes": "Morning fasted weigh-in"
    },
    {
      "event_type": "progress_photo",
      "date_time": "2025-11-01T07:00:10-08:00",
      "photo_url": "https://example.com/photos/2025-11-01-front.jpg",
      "pose": "front"
    },
    {
      "event_type": "dexa_scan",
      "result_id": "r_ABC123",
      "start_time": "2025-10-15T10:32:00-07:00",
      "location": {
        "location_id": "loc_LA01",
        "name": "BodySpec Los Angeles",
        "address": {
          "street": "1234 Sunset Blvd",
          "city": "Los Angeles",
          "state": "CA",
          "postal_code": "90026"
        },
        "timezone": "America/Los_Angeles"
      },
      "scanner_model": "GE Lunar iDXA",
      "sections": {
        "composition": {
          "total": {
            "bone_mass_kg": 3.1,
            "fat_mass_kg": 21.3,
            "lean_mass_kg": 70.9,
            "region_fat_pct": 23.1
          },
          "regions": {
            "trunk": {
              "bone_mass_kg": 0.57,
              "fat_mass_kg": 7.22,
              "lean_mass_kg": 17.32,
              "region_fat_pct": 28.75
            },
            "left_leg": {
              "fat_mass_kg": 3.27,
              "lean_mass_kg": 7.00,
              "region_fat_pct": 30.64
            },
            "right_leg": {
              "fat_mass_kg": 3.03,
              "lean_mass_kg": 7.11,
              "region_fat_pct": 28.81
            }
          },
          "android_gynoid_ratio": 0.91
        },
        "bone_density": {
          "total": {
            "bone_mineral_density": 1.285,
            "bone_mineral_content_g": 1005.8
          },
          "regions": {
            "left_leg": {
              "bone_area_cm2": 376.24,
              "bone_mineral_content_g": 542.5,
              "bone_mineral_density": 1.442
            },
            "trunk": {
              "bone_area_cm2": 782.47,
              "bone_mineral_content_g": 1005.8,
              "bone_mineral_density": 1.285
            }
          }
        },
        "visceral_fat": {
          "vat_mass_kg": 2.8,
          "vat_volume_cm3": 2800
        },
        "percentiles": {
          "bone_density_g_cm2": {
            "value": 1.25,
            "percentile": 82
          },
          "total_body_fat_pct": {
            "value": 25.5,
            "percentile": 45
          },
          "limb_lmi_kg_m2": {
            "value": 8.5,
            "percentile": 85
          },
          "vat_mass_kg": {
            "value": 2.8,
            "percentile": 72
          }
        },
        "scan_info": {
          "acquire_time": "2025-10-15T10:32:00-07:00",
          "analyze_time": "2025-10-15T11:05:00-07:00",
          "scanner_model": "GE Lunar iDXA",
          "patient_intake": {
            "weight_kg": 91.5,
            "height_cm": 193,
            "age": 35,
            "sex": "male"
          }
        }
      },
      "result_pdf": {
        "url": "https://app.bodyspec.com/results/r_ABC123.pdf",
        "last_updated": "2025-10-15T11:10:00-07:00"
      }
    },
    {
      "event_type": "appointment",
      "appt_id": "appt_789",
      "start_time": "2025-10-15T10:00:00-07:00",
      "status": "completed",
      "duration_minutes": 30,
      "service": {
        "service_id": "svc_dexa",
        "name": "DEXA",
        "description": "Body composition and bone density scan"
      },
      "location_id": "loc_LA01"
    }
  ]
}
```

---

### 🧩 Explanation of Sources (from the API spec)
| Section | API Endpoint | Notes |
|----------|---------------|-------|
| **User Info** | `/api/v1/users/me` | Basic user identity, email, phone |
| **Appointments** | `/api/v1/users/me/appts` | Includes service, location, start time, and status |
| **DEXA Scan Results** | `/api/v1/users/me/results/{result_id}` | Core scan data and available sections |
| **DEXA Composition** | `/api/v1/users/me/results/{result_id}/dexa/composition` | Fat/lean/bone by region |
| **Bone Density** | `/api/v1/users/me/results/{result_id}/dexa/bone-density` | Bone metrics |
| **Visceral Fat** | `/api/v1/users/me/results/{result_id}/dexa/visceral-fat` | VAT metrics |
| **Percentiles** | `/api/v1/users/me/results/{result_id}/dexa/percentiles` | Population comparisons |
| **Scan Info** | `/api/v1/users/me/results/{result_id}/dexa/scan-info` | Metadata, scanner info, intake data |
| **Result PDF** | Linked in `/api/v1/users/me/results/{result_id}` | Downloadable PDF |
| **Weight Logs & Photos** | *App custom data* | To be merged client-side |

---

### 🧠 Ideal Integration Flow
1. Authenticate using **OAuth2 PKCE** or **Bearer token**.  
2. Fetch `/api/v1/users/me` for user info.  
3. Get all results from `/api/v1/users/me/results`.  
4. For each `result_id`, query its DEXA sub-sections.  
5. Merge with your **weight logs** and **photo timestamps** for a unified timeline.  
6. Optionally store derived metrics (e.g., fat mass change, lean mass ratio).  

---

Would you like me to generate a **TypeScript interface or schema** for this unified object next, so your app can type-check and validate API responses cleanly?
