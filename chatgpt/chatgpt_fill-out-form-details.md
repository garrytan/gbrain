---
title: "Fill out form details"
type: note
created: 2026-05-26
updated: 2026-05-26
source: chatgpt-export
conversation_id: 6a15d436-dc80-83e8-9360-32477d681c40
message_count: 3
tags: [chatgpt, import, code]
---
# Fill out form details

> Conversation ID: 6a15d436-dc80-83e8-9360-32477d681c40
> Created: 2026-05-26T17:11:22Z
> Updated: 2026-05-26T17:14:45Z
> Messages: 3

---

## User

fill out

---

## Assistant

I’ll use known Jovie details where possible, check what form controls are available, and flag any required fields that still need your input.

---

## Assistant

Mr. White, I don’t have browser-control access in this chat, so I can’t type into the form directly. Use this draft:

| Field | Entry |
|---|---|
| First Name | Tim |
| Last Name | White |
| Company Email | your Jovie email |
| Job Title | Founder |
| Company Website | https://jov.ie |
| Funding Raised | select the accurate range |
| Paying Customers | select the accurate range |
| VCs Affiliated With | list your investors, or “None” |
| Current Cloud Provider | current provider, e.g. AWS / GCP / Azure / Lambda / RunPod / Modal / Other |
| Main Use Cases | Inference, LLMs, Training, Data processing |
| Use Case Details | Jovie is building AI-native tools that require scalable LLM inference, model experimentation, and production-grade infrastructure. We are evaluating Together AI for high-performance inference, fine-tuning, and GPU capacity as we scale usage and customer demand. |

Second page:

| Field | Entry |
|---|---|
| GPUs Needed | NVIDIA H100 / H200 / B200, depending on your actual needs |
| Monthly GPU Spend | select accurate range |
| GPUs Needed Count | select accurate range |
| Model Architecture | Llama / Qwen / DeepSeek / custom open-source LLMs, depending on your stack |
| Timeline | Ready to go live or &lt;3 months, depending on urgency |

Recommended “Share more details” text:

```text
Jovie is an AI-native startup building production AI workflows that require fast, reliable, and cost-efficient inference. We are interested in Together AI for serverless inference, fine-tuning, and GPU access as we scale customer usage. Our use case involves LLM-powered product experiences, experimentation across open-source model architectures, and deployment infrastructure that can support low-latency production workloads.
```

Need-to-know fields before finalizing accurately: funding range, paying customer count, current cloud provider, monthly GPU spend, GPU count, model architecture, and deployment timeline.


## See Also
- [[chatgpt/chatgpt_fill-out-edd-form]]
- [[chatgpt/chatgpt_contact-form-in-nextjs]]
- [[chatgpt/chatgpt_create-new-contact-form-part1]]
- [[chatgpt/chatgpt_create-new-contact-form-part2]]
- [[chatgpt/chatgpt_email-form-to-google-sheet]]
