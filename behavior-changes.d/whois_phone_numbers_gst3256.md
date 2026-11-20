---
kind: add
---
gbrain whois (and the whois MCP tool) now looks up phone numbers: a query written only with digits, spaces and + - . ( ) / is compared with the phone and phones frontmatter of person pages in one canonical form (plus sign, country code, digits), so +1 555 555 0100, (555) 555-0100 and 555.555.0100 find the same person. A number without a country code is read with identity.phone_country_code (default 1). A partial number or the last digits never match. Such a query used to be tried only as a name and usually found nothing; email and name lookups are unchanged, and an email match still ranks first.
