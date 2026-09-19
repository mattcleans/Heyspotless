# Cleaner profiles — bios, photos, and how one gets published

The client app introduces a customer to the person who will be alone in their
house. `0028` built the schema for that; this is the copy and the process that
fills it.

**The one rule that governs everything below:** `cleaners.profile_published`
defaults to `false`. A cleaner appears to customers when she has read her bio,
agreed to it, and agreed to be shown — not because somebody activated her. The
drafts here are drafts *for her*, not copy about her. She edits or rewrites any
of it, and if she would rather not be shown at all, the profile stays unpublished
and the app falls back to "Your cleaner" everywhere. Nothing breaks.

---

## What a customer actually sees

Enumerated once, in the `cleaner_profiles` view. The base `cleaners` table stays
shut, because a row policy on it would hand a customer her hourly rate and her
insurance expiry alongside her name.

| Shown | Not shown |
|---|---|
| First name and last initial — "Marisol A." | Full legal name |
| Photo | Phone, email, address, profile id |
| "3 yrs with us" (rounded **down**) | Pay rate, payout share, tip split |
| Specialty and language chips | Background-check detail beyond "cleared" |
| Rating, once five real ones exist | Acceptance rate, offers declined |
| Completed cleans | Which other customers she cleans for |
| Bio, in her words | Private notes customers left on ratings |

Two of these are worth saying out loud because they look like bugs and are not:

- **No rate, anywhere.** The engine matches cleaners to cleans. A customer is
  meeting the person who is coming, not shopping a marketplace — so there is
  nothing to compare on price and no book-this-cleaner button.
- **No rating under five reviews.** `0024` averages against a prior worth five
  reviews at 4.2, so a brand-new cleaner would otherwise read "4.2" before
  anybody had rated her. The card shows "New to Hey Spotless" or "3 so far"
  instead. Printing the prior as a rating would be presenting an assumption as
  a measurement.

---

## Writing a bio

**Three to four sentences. Hers, in her voice.** The difference between a bio
somebody wrote about themselves and one the office wrote about them is audible
in one sentence, and a customer reads this while deciding whether to trust a
stranger with a key.

What earns its place:

1. **How long, and what she actually likes doing.** Specific beats warm —
   "kitchens and baseboards" tells a customer something; "passionate about
   cleanliness" tells them nothing.
2. **One human detail.** A dog, a neighbourhood, a language, what she did
   before. This is the sentence people remember at the door.
3. **What she is careful about.** Pets, allergies, a particular product, a
   customer who works nights.

What to keep out: last names, neighbourhoods precise enough to find a house,
children's names or schools, anything about pay, and any promise the dispatch
engine cannot keep ("I'll always be your cleaner" — the engine holds continuity
where it can, but it does not guarantee it).

### Drafts to send

Each one goes to the cleaner as *"here's a starting point — change anything,
cross out anything, or write your own."* The bracketed parts are the ones only
she can fill in.

**Shonda** — W-2, the company truck, the backbone of the weekly route.

> I've been cleaning professionally for [X years] and I've been with Hey
> Spotless since [month, year]. Recurring homes are what I'm best at — after a
> couple of visits I know which cabinet sticks and which dog needs the gate
> shut, and I like walking back into a house I already know. Kitchens and
> baseboards are where I slow down. If there's a room you'd rather I always
> start with, tell me once and I'll remember.

Chips: `recurring`, `deep` · Languages: `en`

**Iggy** — 1099, her own vehicle, the flexible half of the week.

> I've been cleaning in DFW for [X years] and I came to Hey Spotless in
> [month, year]. I drive my own car, so I'm the one who can usually get to you
> when something changes at short notice. Move-outs are my favourite job —
> there's no better before-and-after than an empty house. [One human detail.]

Chips: `move_in_out`, `deep` · Languages: `en`

**Template, for every hire after these two.**

> I've been cleaning for [X years], and I joined Hey Spotless in [month, year].
> [What you're best at, and why — one sentence.] [One human detail: a pet, what
> you did before, where you're from.] [Something you're careful about in
> somebody's home.]

**Before it goes live**, someone in the office reads it once for the excluded
list above — last names, addresses, pay, promises the engine can't keep — and
for nothing else. It is not a copy edit. Her grammar is part of her voice.

---

## Photos

**What makes a good one**

- Face fills most of the frame, shoulders up, looking at the camera.
- Daylight, plain or uncluttered background. A wall, a doorway, outside on an
  overcast day. Not a car interior, not a customer's house.
- Clean uniform or a plain shirt. Smiling is better than neutral; neutral is
  better than nothing.
- Nobody else in the frame — no children, no customers, no house numbers, no
  licence plates, nothing on a wall that identifies where she lives.

A phone selfie held at arm's length in good light is genuinely fine. A stock
headshot is worse than her own photo, and an empty avatar is worse than both:
the card falls back to her initials, which at least belong to her.

**The technical part**

| | |
|---|---|
| Bucket | `cleaner-photos` — **private**, 5 MB cap, `image/jpeg`, `image/png`, `image/webp` |
| Path | `cleaners/<cleaner_id>/headshot.jpg` — the second segment is the write policy |
| Column | `cleaners.photo_path` holds **the path**, never a URL |
| Serving | Signed for one hour at render time, in one call per page |
| Size | Square, ~600×600. It is shown at 48px and 80px |

The bucket is private for the same reason `anon` has no grant on
`cleaner_profiles`: her face is shown to the customer whose house she is
cleaning, not published to the open internet. Storing the path rather than a URL
is so the bucket can move without a migration over a column full of absolute
addresses.

---

## The chip catalogue

Fixed keys, not free text — these are filtered and counted, and forty spellings
of "pet friendly" is a filter that matches nothing. Canonical list lives in
`src/lib/cleaners/profile.ts`; add there first.

| Key | Shown as |
|---|---|
| `recurring` | Recurring maid service |
| `deep` | Deep cleaning |
| `move_in_out` | Move in / out |
| `pet_friendly` | Pet-friendly |
| `eco` | Eco-friendly products |
| `organising` | Organising |
| `laundry` | Laundry |

Languages are separate — `en`, `es`, `vi` — because "Speaks Spanish" is not a
skill claim and should not sit in a list of things she is good at.

A specialty is something she says she does, not something the system awards
her. The counted version already exists next to it: `ratings.highlights` tallies
`great_with_pets` across every clean, and forty of those is evidence, where a
chip is a claim.

---

## Publishing one

Three things have to be true, and the order matters — the last step is her
saying yes, so it cannot be the first.

1. She is `active` and background-checked. `cleaner_profiles` filters on
   `status = 'active'`, so an applicant mid-funnel is invisible regardless.
2. Bio, photo, chips and `hired_on` are in.
3. **She has seen the finished profile and agreed to it.** Then, and only then,
   `profile_published = true`.

`hired_on` is not `created_at`. It is the day she started, which for anybody
carried across from Housecall Pro is years before the row existed — and it is
what "3 yrs with us" is counted from. An empty `hired_on` reads "New", which is
the honest answer.

```sql
-- One cleaner, once she has said yes. Run as the service role.
update cleaners set
  bio           = $$<her text, verbatim>$$,
  photo_path    = 'cleaners/' || id || '/headshot.jpg',
  specialties   = array['recurring', 'deep'],
  languages     = array['en'],
  hired_on      = date '2024-03-04',
  profile_published = true
where id = '<cleaner_id>'
  and status = 'active'
  and background_check_cleared;
```

To take one down — she asked, she is on leave, anything at all — it is one
column, and it is reversible:

```sql
update cleaners set profile_published = false where id = '<cleaner_id>';
```

Every screen already handles her absence: the visit tracker says "Your cleaner",
the directory omits her, and the rating screen still works. Nothing needs
deleting and nothing 404s.
