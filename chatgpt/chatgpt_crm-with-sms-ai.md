---
title: "CRM with SMS & AI"
type: guide
created: 2023-05-17
updated: 2023-05-17
source: chatgpt-export
conversation_id: 1b72528a-e7e1-42d9-98ee-1c11ea48e298
message_count: 2
tags: [chatgpt, import, code]
---
# CRM with SMS & AI

> Conversation ID: 1b72528a-e7e1-42d9-98ee-1c11ea48e298
> Created: 2023-05-17T17:15:47Z
> Updated: 2023-05-17T17:16:34Z
> Messages: 2

---

## User

we're building a crm that lets you add contacts via SMS in plain language.  We're using open AI api to parse the plain language and then we scrape their social media profiles for additional data.

please tell us how we can improve our open ai api prompt

{
  "model": "text-davinci-003",
  "prompt": "Given the following data structure:\n{\n'first_name': '',\n'last_name': '',\n'full_name': '',\n'nickname': '',\n'suffix': '',\n'company': '',\n'department': '',\n'title': '',\n'phones': [],\n'website': '',\n'gender': '',\n'emails': [],\n'city': '',\n'country': '',\n'instagram': '',\n'youtube': '',\n'twitter': '',\n'twitch': '',\n'tiktok': '',\n'linkedin': '',\n'snapchat': '',\n'wiki': '',\n'list': '',\n'tags': [],\n'guessed': []\n}\n\nProcess the given data to fill the above json object structure. Please consider the following rules strictly:\n\nAdd keys of guessed values in the 'guessed' array (for values not provided in the given data).\nAdd the gender based on the name if gender is not given in the data.\nAdd the country name based on the first four digits of the phone number if country is not given in the data.\nFor the tags, add words that contain hashtags or number signs.\n\n$data\n",
  "temperature": 0,
  "max_tokens": 701,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0
}

---

## Assistant

Your current OpenAI API prompt provides a clear structure and instructions for processing the given data. However, there are a few suggestions to improve the prompt:

1. Simplify the data structure: The provided data structure is lengthy and contains multiple empty fields. To streamline the prompt, consider including only the necessary fields and removing the empty ones. This will make the prompt easier to read and understand.

2. Provide examples or sample data: Including examples or sample data within the prompt can help the model better understand the expected input and output. You can provide a few examples of plain language queries and their corresponding expected output in the JSON structure.

3. Clarify the expected input format: Specify the expected format of the plain language input. For example, you can mention that the plain language queries should include specific keywords or follow a certain pattern to ensure accurate parsing and processing.

4. Add more details about scraping social media profiles: Since you mentioned scraping social media profiles for additional data, it would be helpful to provide more information about the specific social media platforms you plan to scrape. Additionally, you might want to mention any limitations or constraints related to scraping data from social media platforms.

Here's an improved version of the OpenAI API prompt taking these suggestions into account:

```json
{
  "model": "text-davinci-003",
  "prompt": "We're building a CRM system that allows users to add contacts via SMS using plain language. The system will parse the plain language and scrape social media profiles for additional data. We need your assistance in processing the given data and filling the JSON object structure below.\n\nJSON Object Structure:\n{\n  'first_name': '',\n  'last_name': '',\n  'full_name': '',\n  'nickname': '',\n  'suffix': '',\n  'company': '',\n  'department': '',\n  'title': '',\n  'phones': [],\n  'website': '',\n  'gender': '',\n  'emails': [],\n  'city': '',\n  'country': '',\n  'instagram': '',\n  'youtube': '',\n  'twitter': '',\n  'twitch': '',\n  'tiktok': '',\n  'linkedin': '',\n  'snapchat': '',\n  'wiki': '',\n  'list': '',\n  'tags': [],\n  'guessed': []\n}\n\nInstructions:\n- Process the given data to fill the above JSON object structure.\n- Add keys of guessed values to the 'guessed' array (for values not provided in the given data).\n- Add the gender based on the name if it is not given in the data.\n- Add the country name based on the first four digits of the phone number if it is not given in the data.\n- For tags, add words that contain hashtags or number signs.\n\nPlease provide the necessary code to accomplish the task. You can also include examples of plain language queries and their expected output in the JSON structure.\n\n$data\n",
  "temperature": 0,
  "max_tokens": 701,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0
}
```

Remember to replace `$data` with actual examples or sample data you want to provide for processing.


## See Also
- [[chatgpt/chatgpt_1password-with-chatgpt-atlas]]
- [[chatgpt/chatgpt_adjusting-parfait-with-pecans]]
- [[chatgpt/chatgpt_arguing-with-facts]]
- [[chatgpt/chatgpt_auth-system-with-toast-pin]]
- [[chatgpt/chatgpt_beat-competitor-with-thesis]]
