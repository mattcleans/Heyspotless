# Reopen a started visit without signal

The build plan calls for an offline job cache. The photo queue is durable, but a restarted page currently requires the server. This work provides a static recovery screen and a minimal saved checklist for already-started work. It does not cache a dispatch board or treat a stored assignment as current permission.

## Design plan

Use existing Hey Spotless colors: ocean #075e7b, navy #245478, sunshine #fae47a, white #ffffff, ground #f6f9fb and line #d6e2ea. Use the system sans stack at 16px for instructions and actions, with a 28px heading. Keep the phone view left aligned, one column, with room labels beside paired 44px before/after buttons. A yellow connection notice carries the distinction between saved work and current server confirmation.

```
Hey Spotless                         Call office
Your saved work
Connection notice + last checked time
Started visit date (no name, address or pay)
Kitchen                     Before / After
Bathroom                    Before / After
Saved on this phone; upload when connected
Check visit online
```

Review against the brief: keep the familiar room order and paired capture controls, rather than a generic offline dashboard. Remove job IDs from the visible list; distinguish visits by the saved Dallas date/time and explain that these are earlier checklists. Keep start, finish, cleaner acceptance, messages and payments in the authenticated online app. The recovery page has no external fonts or assets and does not need push permission.

## Behavior and verification requirements

- Only authenticated, owned started/completed visit pages may save a minimal snapshot: owner, visit, server-checked time, room keys/labels and confirmed photo pairs. No client name, home address, notes, gate code, price, pay, token or provider key is stored in the snapshot.
- Recovery is network first, only after a navigation fails. An HTTP auth refusal/error is never replaced by cached private content. Live pages/API/dispatch records are never cached. Static recovery assets are cached separately.
- Offline captures use the existing committed IndexedDB photo schema and retake revision. No upload, start, completion or client message is queued by this screen. Returning online reopens the authenticated visit, whose existing queue resumes uploads after server authorization.
- The local checklist is device recovery, not proof the assignment is still current. Expired snapshots stop new capture; pending bytes remain. Confirmed room markers survive successful uploads without overwriting a newer retake.
- Changing signed-in profile or signing out clears checklist visibility, without deleting unconfirmed photos. Test storage failure, expiry, cross-profile clearing, retakes and worker fallback/auth behavior. Browser proof must include a cold navigation served from the offline fallback, not merely a loaded page with the network disconnected. Physical-phone restart and authenticated preview remain separate release evidence.

## Critique and observed evidence

The yellow notice makes the saved/live distinction visible before the room actions. At 390px the room label and paired controls fit without overflow; at 320px controls move below each label and expand to 140px width. All photo/online actions are at least 44px high. Visible focus uses the brand ocean outline. The static screen has no animation, external typeface, customer identity or access details. The repeated online link supports returning from a checklist and the final recovery instruction; it does not imply a current appointment.

A clearly fictional local harness prepared the production cache, then the app server was stopped. A new navigation opened the static recovery page at a visit URL. A local test image was captured, remained marked saved after a further cold reload, and was listed as waiting to upload. This proves browser fallback and local durability, not physical-phone behavior or authenticated account acceptance. The fictional records were removed through the harness, then the harness and development server were removed before final checks. The screenshot remains in the private workspace.
