# Legal pointers

This is not legal advice. It lists the texts a site owner should read before using device identification, and what VisitoJS does and does not do that matters to them.

## What the library does

- Reads values the browser exposes to any script and builds identifiers from them: user agent, language, memory bucket and text size; client hints when the user agent hides the phone model; screen size and core count when the browser names no model. The lab build, meant for test pages, also reads a canvas and an audio render, locale settings and further screen and display values.
- The optional deep entry (`visitojs/deep`), when the page calls it, draws two canvas scenes and renders a short offline audio clip, reads the result back and builds a second identifier from it. That is fingerprinting in the sense of the EDPB guidelines below. It stores nothing and sends nothing, and it reads nothing until the page calls `get()`: the call is the moment the site's legal basis, consent where it is needed, must already exist.
- Stores one random id in a first-party cookie and in localStorage. Each copy restores the other: an id removed from only one of the two places comes back from the other on the next page view. Clearing the site's data removes both.
- Caches the text-size values and, where the user agent hides the phone model, the client-hint values of a complete reading, in localStorage or, when that is unavailable, sessionStorage. The cache is used for 24 hours and kept until a later complete reading replaces it or the browser clears it: nothing deletes it when the 24 hours are up.
- Sends nothing anywhere. The page that loads it decides what leaves the browser.
- Stores nothing outside the site's own cookie, localStorage and sessionStorage. On the WebKit and Gecko engines, the private-window check also opens the site's origin private file system with `navigator.storage.getDirectory()` and writes nothing to it; the product build does this only on a view whose stored id is new or cannot be kept, the lab build on every view. Once both copies of the id are gone, nothing rebuilds it: the next id is a new random one.
- The deferred build (`visitojs/defer`, `visito.defer.min.js`) reads nothing and stores nothing until the page calls `start()`: not the browser's values, not the cookie, not storage. From `start()` on it does what the product build does.
- `start({ store: false })` reads the device as above but reads and writes no cookie, no localStorage and no sessionStorage, and opens no origin private file system. It still computes the ids, and the page can still send them anywhere.
- Collects no consent and records none. The page decides when to call `start()`.

## European Union

The European Data Protection Board's Guidelines 2/2023 on the technical scope of Article 5(3) of the ePrivacy Directive (version 2.0, adopted 7 October 2024) state that fingerprinting falls within that article. Reading information from a user's device then needs consent unless an exemption applies, and fraud prevention is not listed as one in the directive itself.
https://edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf

Reading a device to identify it is itself covered, not only storing something on it. The same guidelines (paragraphs 32 and 33) treat JavaScript that has the browser hand over information as gaining access within Article 5(3), and paragraph 53 adds that information produced on the device and then sent to a server is gained access too, even though it was produced locally. So `start({ store: false })`, which reads the device and stores nothing, is not by itself an exemption from the need for consent in the EU: it removes the storage, not the reading. The deferred build lets a page wait for the visitor's choice before any reading; it does not collect, record or check that choice.

Where the identifiers relate to a person, the GDPR applies to their storage and use.

Sites that use the IAB Europe Transparency & Consent Framework: its policies (version 2026-05-29.5.0.b) list "Identify devices based on information actively requested" as Special Feature 2, which users must opt in to before a vendor uses it (Chapter III 14(12)), and say that its use for security and fraud falls under Special Purpose 1 instead. The CMP API (v2.2) gives the opt-in as `specialFeatureOptins[2]` and purpose 1, storing or accessing information on a device, as `purpose.consents[1]`. Which of these a site's use needs is the site's decision.
https://iabeurope.eu/iab-europe-transparency-consent-framework-policies/
https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md

## United Kingdom

The ICO's guidance on storage and access technologies under PECR says regulation 6 applies to device fingerprinting where it stores information, or accesses information stored, on a device. Read on 13 November 2026.
https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/

## Other countries

The EU's rules are set out above because they say the most about reading from a device. Most countries, and several US states, have personal-data laws of their own, and some regulate cookies and similar technologies separately. A site owner checks the law where their visitors are. This file is not a list of those laws.

## When consent is withdrawn

The library has no call that forgets. What it stored is the cookie and the localStorage entry named `_visito` (or the name set in `VisitoConfig.did`), and the cache under that name plus `_c`, in localStorage or, where localStorage is unavailable, sessionStorage. These lines remove all of them:

```js
var name = '_visito' // or the name set in VisitoConfig.did
document.cookie = name + '=; Path=/; Max-Age=0' + (location.protocol === 'https:' ? '; Secure' : '')
try { localStorage.removeItem(name); localStorage.removeItem(name + '_c') } catch (e) {}
try { sessionStorage.removeItem(name + '_c') } catch (e) {}
```

Each storage has its own `try`: where reading `localStorage` throws, the cache is in sessionStorage, and the last line still runs.

Run them after `get()` has called back on that page view: the cache is written when the reading finishes, so lines run earlier can be followed by a new cache entry. On later views, do not call `start()` until consent is given again. The reading already in the page's memory goes away with the page; the library sends nothing, so copies the site sent to its own server are the site's to delete. `lab/defer.mjs` checks these lines in Chromium, Firefox and WebKit, also with `localStorage` throwing.

## What a site owner decides

Whether to show a notice, on which legal basis the identifiers are processed, how long readings are kept, and whether they leave the country. Whether and when to call `start()` in the deferred build, and with which option. The library takes no position on any of these.
