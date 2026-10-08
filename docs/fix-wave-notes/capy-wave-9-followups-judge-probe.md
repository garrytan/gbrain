# Wave 9 follow-ups: judge thinking probe record

The exact requests and responses of the capped live probe behind the thinking capability table in `src/core/ai/thinking-off.ts` ([wave notes](capy-wave-9-followups.md#judge-thinking-caps-lane-j)).

## Exact requests and responses

Bodies are the JSON the SDK sent and received, pretty-printed. Headers were not logged; the logger refused any URL carrying a key, and the Google key travelled in the `x-goog-api-key` header. The opaque `thoughtSignature` blobs are elided by length.

Run at 2026-10-07T00:50:09.448Z. Worst-case bound (every call hitting its cap at the upper-bound prices): $0.0162. Actual spend from reported usage: $0.00397.

### G1: `google:gemini-2.5-flash`, maxOutputTokens 600 (master behaviour: no thinkingConfig)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The calculation for the arrival time is correct.\"}"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 21,
    "totalTokenCount": 302,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 193,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "M5fFatSsOdX1jMcPr4yekAM"
}
```

### G1b: `google:gemini-2.5-flash`, maxOutputTokens 128 (master behaviour, small cap: do thoughts consume maxOutputTokens?)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 128
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": "
          }
        ],
        "role": "model"
      },
      "finishReason": "MAX_TOKENS",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 3,
    "totalTokenCount": 211,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 120,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "NZfFau_8CNnb-8YPoKy1gQQ"
}
```

### G2: `google:gemini-2.5-flash`, maxOutputTokens 600 (branch thinking:'off' mapping)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600,
    "thinkingConfig": {
      "thinkingBudget": 0
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"3:40 + 2h 35m = 6:15\"}"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 30,
    "totalTokenCount": 118,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "NpfFapH9AvmtsOIPuOuLiAQ"
}
```

### G3: `google:gemini-2.5-flash`, maxOutputTokens 64 (negative: thinkingLevel on 2.5 (table never sends it))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "Thinking level is not supported for this model.",
    "status": "INVALID_ARGUMENT"
  }
}
```

### G4: `google:gemini-3.8-flash`, maxOutputTokens 600 (no thinkingConfig (default medium))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The arrival time calculation is completely correct.\"}",
            "thoughtSignature": "<elided: 584-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 20,
    "totalTokenCount": 238,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 130,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "NpfFapyvKuHJ39IPp7WqmQE"
}
```

### G4b: `google:gemini-3.8-flash`, maxOutputTokens 128 (no thinkingConfig, small cap)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 128
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 1",
            "thoughtSignature": "<elided: 520-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "MAX_TOKENS",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 5,
    "totalTokenCount": 212,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 119,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "OZfFavmMAbCc-8YPsIH3WQ"
}
```

### G5: `google:gemini-3.8-flash`, maxOutputTokens 600 (branch thinking:'off' mapping (floor))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600,
    "thinkingConfig": {
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The calculated arrival time is mathematically correct.\"}",
            "thoughtSignature": "<elided: 420-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 20,
    "totalTokenCount": 198,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 90,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "O5fFarjQF42hjrEP8tKMMA"
}
```

### G6: `google:gemini-3.8-flash`, maxOutputTokens 64 (negative: thinkingLevel minimal on 3.8 Flash)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingLevel": "minimal"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.",
    "status": "INVALID_ARGUMENT"
  }
}
```

### G7: `google:gemini-3.8-flash`, maxOutputTokens 64 (negative: both Google fields)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingBudget": 0,
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "You can only set only one of thinking budget and thinking level.",
    "status": "INVALID_ARGUMENT"
  }
}
```

### O1: `openai:gpt-5.2`, maxOutputTokens 200 (master behaviour: no reasoningEffort)

Request (`POST https://api.openai.com/v1/responses`; headers, including the API key header, not recorded):

```json
{
  "model": "gpt-5.2",
  "input": [
    {
      "role": "developer",
      "content": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "max_output_tokens": 200
}
```

Response (HTTP 200):

```json
{
  "id": "resp_0a9c3f8ec573dd13006ac5973e823c87d1905d24cd91111bf9",
  "object": "response",
  "created_at": 1791334206,
  "status": "completed",
  "access_programs": null,
  "background": false,
  "billing": {
    "payer": "developer"
  },
  "completed_at": 1791334207,
  "error": null,
  "frequency_penalty": 0,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": 200,
  "max_tool_calls": null,
  "model": "gpt-5.2-2025-12-11",
  "moderation": null,
  "output": [
    {
      "id": "msg_0a9c3f8ec573dd13006ac5973f07d487d192d47ea58083e6a8",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "annotations": [],
          "logprobs": [],
          "text": "{\"score\": 10, \"reason\": \"3:40 pm + 2:35 equals 6:15 pm.\"}"
        }
      ],
      "role": "assistant"
    }
  ],
  "parallel_tool_calls": true,
  "presence_penalty": 0,
  "previous_response_id": null,
  "prompt_cache_key": null,
  "prompt_cache_retention": "24h",
  "reasoning": {
    "context": "current_turn",
    "effort": "none",
    "mode": "standard",
    "summary": null
  },
  "safety_identifier": null,
  "service_tier": "default",
  "store": true,
  "temperature": 1,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tool_usage": {
    "image_gen": {
      "input_tokens": 0,
      "input_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "output_tokens": 0,
      "output_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "total_tokens": 0
    },
    "web_search": {
      "num_requests": 0
    }
  },
  "tools": [],
  "top_logprobs": 0,
  "top_p": 0.98,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 92,
    "input_tokens_details": {
      "cache_write_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens": 31,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 123
  },
  "user": null,
  "metadata": {}
}
```

### O2: `openai:gpt-5.2`, maxOutputTokens 200 (branch thinking:'off' mapping)

Request (`POST https://api.openai.com/v1/responses`; headers, including the API key header, not recorded):

```json
{
  "model": "gpt-5.2",
  "input": [
    {
      "role": "developer",
      "content": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "max_output_tokens": 200,
  "reasoning": {
    "effort": "none"
  }
}
```

Response (HTTP 200):

```json
{
  "id": "resp_081f0f2437fa7263006ac59740421087d1a18274c9f986ef0e",
  "object": "response",
  "created_at": 1791334208,
  "status": "completed",
  "access_programs": null,
  "background": false,
  "billing": {
    "payer": "developer"
  },
  "completed_at": 1791334209,
  "error": null,
  "frequency_penalty": 0,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": 200,
  "max_tool_calls": null,
  "model": "gpt-5.2-2025-12-11",
  "moderation": null,
  "output": [
    {
      "id": "msg_081f0f2437fa7263006ac59740de7087d1a2a28eaf27037077",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "annotations": [],
          "logprobs": [],
          "text": "{\"score\": 10, \"reason\": \"3:40 plus 2:35 equals 6:15 pm.\"}"
        }
      ],
      "role": "assistant"
    }
  ],
  "parallel_tool_calls": true,
  "presence_penalty": 0,
  "previous_response_id": null,
  "prompt_cache_key": null,
  "prompt_cache_retention": "24h",
  "reasoning": {
    "context": "current_turn",
    "effort": "none",
    "mode": "standard",
    "summary": null
  },
  "safety_identifier": null,
  "service_tier": "default",
  "store": true,
  "temperature": 1,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tool_usage": {
    "image_gen": {
      "input_tokens": 0,
      "input_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "output_tokens": 0,
      "output_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "total_tokens": 0
    },
    "web_search": {
      "num_requests": 0
    }
  },
  "tools": [],
  "top_logprobs": 0,
  "top_p": 0.98,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 92,
    "input_tokens_details": {
      "cache_write_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens": 30,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 122
  },
  "user": null,
  "metadata": {}
}
```
