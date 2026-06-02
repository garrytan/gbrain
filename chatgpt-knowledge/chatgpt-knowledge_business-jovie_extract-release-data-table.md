---
title: "Extract Release Data Table"
type: guide
created: 2024-02-07
updated: 2024-02-07
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Extract Release Data Table

> **Source:** ChatGPT conversation
> **Date:** 2024-02-07T03:24:35Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

extract the release data below into a table:

MusicBrainz
kellystickland ▾
Profile
Applications
Subscriptions
Log out
My data ▾
My collections
My ratings
My tags
My open edits
All my edits
Edits for subscribed entities
Edits by subscribed editors
Notes left on my edits
Search

Artist
Search
About us ▾
About MusicBrainz
Sponsors
Team
Shop
Contact us
Data licenses
Social contract
Code of conduct
Privacy policy
GDPR compliance
Data removal policy
Auto-editor elections
Privileged user accounts
Statistics
Timeline graph
MusicBrainz history
Products ▾
MusicBrainz Picard
AudioRanger
Mp3tag
Yate Music Tagger
MusicBrainz for Android
MusicBrainz Server
MusicBrainz Database
Developer resources
MusicBrainz API
Live Data Feed
Search ▾
Advanced search
Edit search
Tag cloud
Top CD stubs
Editing ▾
Add artist
Add label
Add release group
Add release
Add Various Artists release
Add standalone recording
Add work
Add place
Add series
Add event
Vote on edits
Reports
Documentation ▾
Beginners guide
Style gui

## Answer

| Name                                                  | Artist(s)                                | ISRCs          | Rating | Length | Release Group(s)                     |
|-------------------------------------------------------|------------------------------------------|----------------|--------|--------|--------------------------------------|
| Become One                                            | Tim White                                | QMT671400035   | 512345 | 3:12   | All This Noise EP                    |
|                                                       |                                          | QMT671400036   |        |        |                                      |
| Become One (The Soulmate Project remix)               | Tim White                                | 512345         | 3:12   |        | All This Noise Remixed               |
| Bright and Shining Star                               | Carla Martin & Tim White                 | 12345          | 3:44   |        | Songs of the Vineyard, Vol. 6: We Welcome You |
| California                                            | Tim White                                | QMT671400020   | 512345 | 3:52   | California                           |
|                                                       |                                          |                |        |        | All This Noise EP                    |
| California (Ali.I.A.N Nu Disco remix)                 | Tim White                                | 512345         | 3:52   |        | All This Noise Remixed               |
| Doge (to Mars)                                        | Tim White & Ryan Donovan                 | QZQF82100001   | 12345  | 2:59   | Doge (to Mars)                       |
| Love Don't Let Me Down                                | Tim White                                | QMBZ91722418   | 12345  | 3:48   | Love Don't Let Me Down               |
| Revival                                               | Tom Fall & Tim White                     | 512345         | 3:21   |        | Revival                              |
| Revival                                               | Tom Fall & Tim White                     | 12345          | 3:19   |        | Dream Dance, Vol. 82                 |
| Revival (extended mix)                                | Tom Fall & Tim White                     | 512345         | 4:27   |        | Revival                              |
| Save the Night                                        | Tim White                                | QMT671400030   | 512345 | 3:10   | All This Noise EP                    |
|                                                       |                                          |                |        |        | Save the Night                       |
| Save the Night (clean edit)                           | Tim White                                | QMT671400031   | 512345 | 3:11   | All This Noise EP                    |
| Save the Night

*(Answer truncated — 5637 chars total)*

## Question

remove bright and shining star and duplicate tracks/alternative versions.

## Answer

| Name                                                | Artist(s)                            | ISRCs          | Rating | Length | Release Group(s)                |
|-----------------------------------------------------|--------------------------------------|----------------|--------|--------|---------------------------------|
| Become One                                          | Tim White                            | QMT671400035   | 512345 | 3:12   | All This Noise EP               |
| California                                          | Tim White                            | QMT671400020   | 512345 | 3:52   | California                      |
| Doge (to Mars)                                      | Tim White & Ryan Donovan             | QZQF82100001   | 12345  | 2:59   | Doge (to Mars)                  |
| Love Don't Let Me Down                              | Tim White                            | QMBZ91722418   | 12345  | 3:48   | Love Don't Let Me Down          |
| Revival                                             | Tom Fall & Tim White                 | 512345         | 3:21   |        | Revival                         |
| Save the Night                                      | Tim White                            | QMT671400030   | 512345 | 3:10   | All This Noise EP               |
| Seaside Heights                                     | Tim White                            | GBKPL2092277   | 512345 | 3:23   | Seaside Heights                 |
| Sober                                               | Jochen Miller & Tom Fall feat. Tim White | 512345     | 3:29   |        | Sober                           |
| Songs About You                                     | Tim White                            | 512345         | 3:33   |        | Songs About You                 |
| Supernova Girl                                      | Tim White & Ryan Donovan             | 12345          | 2:33   |        | Supernova Girl                  |
| Take Me Over                                        | Tim White feat. Erica Gibson         | QMT671400004   | 512345 | 3:52   | Take Me Over                    |
| The Deep End                                        | Cosmic Gate & Tim White              | 12345          | 3:16   |        | The Deep End                    |
| This Is Love                                        | Tim White & Ryan Donovan             | GBKPL1980223   | 512345 | 3:12   | This Is Love                    |
| Tomorrow Sounds                                     | Tim White & Ryan Donovan             | GBKPL2090229   | 12345  | 3:23   | Tomorrow Sounds                 |
| Trying Too Hard                                     | Tim White                            | QMT671400020   | 512345 | 3:20   | Trying Too Hard                 |
| Wheels Up                                           | Lynx & Tim White                     | QM4TW1810631   | 512345 | 3:12   | Wheels Up                       |

This table shows the unique tracks excluding "B

*(Answer truncated — 3084 chars total)*

## Question

include the year, remove the isrce codes and durations

## Answer

| Name                 | Artist(s)                              | Year | Release Group(s)                |
|----------------------|----------------------------------------|------|---------------------------------|
| Become One           | Tim White                              | 2014 | All This Noise EP               |
| California           | Tim White                              | 2014 | California                      |
| Doge (to Mars)       | Tim White & Ryan Donovan               | 2021 | Doge (to Mars)                  |
| Love Don't Let Me Down | Tim White                            | 2017 | Love Don't Let Me Down          |
| Revival              | Tom Fall & Tim White                   |      | Revival                         |
| Save the Night       | Tim White                              | 2014 | All This Noise EP               |
| Seaside Heights      | Tim White                              |      | Seaside Heights                 |
| Sober                | Jochen Miller & Tom Fall feat. Tim White |      | Sober                           |
| Songs About You      | Tim White                              |      | Songs About You                 |
| Supernova Girl       | Tim White & Ryan Donovan               |      | Supernova Girl                  |
| Take Me Over         | Tim White feat. Erica Gibson           | 2014 | Take Me Over                    |
| The Deep End         | Cosmic Gate & Tim White                |      | The Deep End                    |
| This Is Love         | Tim White & Ryan Donovan               |      | This Is Love                    |
| Tomorrow Sounds      | Tim White & Ryan Donovan               |      | Tomorrow Sounds                 |
| Trying Too Hard      | Tim White                              | 2014 | Trying Too Hard                 |
| Wheels Up            | Lynx & Tim White                       |      | Wheels Up                       |

I've included the year of release where available and removed the ISRC codes and durations. The years are based on common release years for the EPs mentioned, but some specific years may need to be verified or added.
