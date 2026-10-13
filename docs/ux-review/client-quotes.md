# Client quote acceptance and office booking

The build plan calls for an instant estimate, client quote acceptance and office scheduling. The public form remains an inquiry until the office verifies the home and prepares terms. A quote is an offer to book; accepting it does not claim a cleaner has accepted or charge a card.

## Design pass

Keep the existing Hey Spotless palette: ocean #075e7b for actions, navy #245478 for headings, sunshine #fae47a for the proposed appointment, white #ffffff for the quote sheet, ground #f6f9fb and line #d6e2ea. Use the app's system sans and tabular money. Left-align the page and keep the quote sheet readable at 320px.

Office: saved home and room counts → service/cadence/extras/date → immutable price review → publish to the client account → accepted terms → book that date. Client: home/service → price breakdown → proposed appointment and recurrence → accept or decline → saved decision → booked visit link. The date and price belong together because those are the agreement, not decoration.

```
Quote for your home                    [status]
Home / service
$ amount per clean
Line                       qty          amount
Proposed first appointment / repeats / expiry
[Accept quote] [Decline quote]
Saved decision / office scheduling / actual visit link
```

## Brief review before implementation

Use one quote sheet instead of a grid of equally weighted cards. Retain existing typography and navigation because these screens belong inside a working operations app. The primary action names the actual outcome: publishing, accepting or booking. Only the booking receipt links to a visit. A proposed date stays labelled proposed while the office schedules. Recurrence requires an explicit choice, and extras appear in both pricing and the work instructions.

Quotes are immutable once prepared; publishing checks the saved property snapshot. Decisions are owned, versioned and retry-safe. A client can replace their decision until booking; office withdrawal ends the offer. Booking locks the quote and uses the exact accepted stored price, not a later price book. Stale home, expired terms and changed decisions require fresh review.

## Build critique

The completed sheet keeps the price, line items and proposed first appointment together. Repeated dates use the stored Dallas wall time; the booked sheet links to the current visit instead of presenting the historical quote date as the current schedule. The preparation form uses stored room counts and explicit extra quantities. At 320px and 390px, the sheet and input controls stay inside the viewport. Actions are 44–48px tall and form controls 44px. The local fictional harness was removed after review. Backend and actual authenticated browser acceptance are separate evidence.
