---
title: "Untitled Conversation 261"
type: guide
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: 1f5812b3-5ea3-45c2-be10-1d260a8c3293
message_count: 4
tags: [chatgpt, import, code]
---
# Untitled Conversation 261

> Conversation ID: 1f5812b3-5ea3-45c2-be10-1d260a8c3293
> Created: 2022-12-10T19:16:23Z
> Updated: 2022-12-10T19:16:23Z
> Messages: 4

---

## User

right a function that when give a url returns the name of the social media network.

Make it work for twitter, instagram, tiktok, spotify, snapchat, facebook, linkedin, bumble, tinder, beacons.ai, linktree, twitch, and medium

---

## Assistant

Here is one way to implement a function that takes a URL and returns the name of the social media network associated with it:

```
def get_social_media_network(url):
    if "twitter" in url:
        return "Twitter"
    elif "instagram" in url:
        return "Instagram"
    elif "tiktok" in url:
        return "TikTok"
    elif "spotify" in url:
        return "Spotify"
    elif "snapchat" in url:
        return "Snapchat"
    elif "facebook" in url:
        return "Facebook"
    elif "linkedin" in url:
        return "LinkedIn"
    elif "bumble" in url:
        return "Bumble"
    elif "tinder" in url:
        return "Tinder"
    elif "beacons.ai" in url:
        return "Beacons.ai"
    elif "linktree" in url:
        return "Linktree"
    elif "twitch" in url:
        return "Twitch"
    elif "medium" in url:
        return "Medium"
    else:
        return "Unknown"
```

This function uses the `in` keyword to check if the URL contains the name of the social media network. If it does, it returns the name of the network. Otherwise, it returns "Unknown".

You can test this function using the following code:

```
url1 = "https://twitter.com/openai"
url2 = "https://www.instagram.com/openai/"
url3 = "https://www.tiktok.com/@openai"
url4 = "https://open.spotify.com/user/openai"
url5 = "https://www.snapchat.com/add/openai"
url6 = "https://www.facebook.com/openai"
url7 = "https://www.linkedin.com/company/openai/"
url8 = "https://www.bumble.com/openai"
url9 = "https://www.tinder.com/openai"
url10 = "https://beacons.ai/openai"
url11 = "https://www.linktree.com/openai"
url12 = "https://www.twitch.tv/openai"
url13 = "https://www.medium.com/@openai"

print(get_social_media_network(url1)) # should print "Twitter"
print(get_social_media_network(url2)) # should print "Instagram"
print(get_social_media_network(url3)) # should print "TikTok"
print(get_social_media_network(url4)) # should print "Spotify"
print(get_social_media_network(url5)) # should print "Snapchat"
print(get_social_media_network(url6)) # should print "Facebook"
print(get_social_media_network(url7)) # should print "LinkedIn"
print(get_social_media_network(url8)) # should print "Bumble"
print(get_social_media_network(url9)) # should print "Tinder"
print(get_social_media_network(

---

## User

refactor this code

---

## Assistant

One way to refactor the code is to use a dictionary to map URLs to social media network names. This will make it easier to add new networks or update the names of existing networks.

Here is an example of how you could implement this:

```
def get_social_media_network(url):
    networks = {
        "twitter": "Twitter",
        "instagram": "Instagram",
        "tiktok": "TikTok",
        "spotify": "Spotify",
        "snapchat": "Snapchat",
        "facebook": "Facebook",
        "linkedin": "LinkedIn",
        "bumble": "Bumble",
        "tinder": "Tinder",
        "beacons.ai": "Beacons.ai",
        "linktree": "Linktree",
        "twitch": "Twitch",
        "medium": "Medium"
    }
    
    for network, name in networks.items():
        if network in url:
            return name
    
    return "Unknown"
```

This code uses a dictionary to map the names of social media networks to their corresponding network names. It then loops through the dictionary and checks if the URL contains the name of the network. If it does, it returns the corresponding network name. Otherwise, it returns "Unknown".

You can test this function using the same code as before:

```
url1 = "https://twitter.com/openai"
url2 = "https://www.instagram.com/openai/"
url3 = "https://www.tiktok.com/@openai"
url4 = "https://open.spotify.com/user/openai"
url5 = "https://www.snapchat.com/add/openai"
url6 = "https://www.facebook.com/openai"
url7 = "https://www.linkedin.com/company/openai/"
url8 = "https://www.bumble.com/openai"
url9 = "https://www.tinder.com/openai"
url10 = "https://beacons.ai/openai"
url11 = "https://www.linktree.com/openai"
url12 = "https://www.twitch.tv/openai"
url13 = "https://www.medium.com/@openai"

print(get_social_media_network(url1)) # should print "Twitter"
print(get_social_media_network(url2)) # should print "Instagram"
print(get_social_media_network(url3)) # should print "TikTok"
print(get_social_media_network(url4)) # should print "Spotify"
print(get_social_media_network(url5)) # should print "Snapchat"
print(get_social_media_network(url6)) # should print "Facebook"
print(get_social_media_network(url7)) # should print "LinkedIn"
print(get_social_media_network(url8)) # should print "Bumble"
print(get_social_media_network(url9)) # should print "Tinder"
print(get_social_media_network(url10)) # should print "Beacons.ai"
print(get_social_media_network(url11)) # should print "Link


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-265]]
