# Hey Spotless experience release

This release builds on the existing Next.js application. The requested sequence is web first, then native iOS and Android. Housecall Pro remains the current operating system. This branch does not connect or migrate its live records.

## Design

The customer-flow PDF establishes ocean blue (#075e7b), sunshine (#fae47a), white (#ffffff), pale blue (#e8f5f8), and readable slate (#526977). System sans type keeps the app fast and familiar on phones. A large welcoming headline and one rounded blue booking panel carry the identity. Visit details and actions remain left aligned. Bottom navigation identifies the current customer area. Cleaner screens use the same brand with a focused daily workspace, while management has a wider overview.

## Implemented

- Customer home prioritizes an existing visit, reads the actual assignment stage, offers a recent-clean feedback path, and provides direct phone support.
- Customer navigation identifies the current tab. Service links preserve the selected service in the estimate form.
- The inquiry flow has home/service, details, and review steps. It explicitly says a request is not a confirmed booking. Text consent starts unchecked. Preview mode cannot submit requests.
- Cleaner workspace separates daily visits, available offers, and upcoming appointments. It uses the business timezone, preserves booked appointment order, and does not truncate today's schedule to four visits. Missing live cleaner profiles do not fall back to an unfiltered job query.
- Contractor visit cards read agreed assignment pay. Employee cards refer to hourly terms rather than displaying a contractor percentage. Missing pay is not invented.
- Management overview at /admin shows local-day counts, missing visit times, late unstarted work, and unassigned visits in the next 24 hours. It links to the existing customer, dispatch, inbox, and lead workflows.

## Release boundaries

This is a working experience increment, not certification that the entire platform is ready to replace Housecall Pro. Existing booking is lead intake. Instant availability, reservation locking, customer-selected cleaner acceptance, backup approval, and payment confirmation still need an end-to-end implementation. The existing cleaner directory is informational, not a selectable marketplace. The management overview is read-only and does not automatically resolve assignments or contact customers.

Preferred-cleaner requests with explicit confirmation are the recommended next step. Never promise the same person before acceptance. A backup change should be visible to the customer. Existing dispatch policies require further changes before that promise can be made.

Housecall Pro requires verified account/API access and a defined record owner before integration. Establish customer/property/job ID mappings, deduplicated imports, cancellation handling, reconciliation, and one billing owner per visit. There is currently a CSV importer, not a verified bidirectional sync. Do not enable parallel charging.

Before a live pilot, verify customer and cleaner account permissions, a real visit from request through completion, agreed pay, review/tip collection, failure recovery, and payment authorization in a non-production environment. Test offline cleaner photo recovery on a physical phone. Configure market timezone and service coverage before entering another market; current screens label Dallas accurately.

## Validation

- Exact lockfile dependencies restored using Node 24.
- 726 tests pass in UTC and America/Chicago, including five new scheduling regressions. Five existing live-service tests remain skipped.
- ESLint and TypeScript pass.
- Production build passes with `next build --webpack`. Default Turbopack cannot bind its worker port in this environment.
- Browser visual and interaction review is outstanding: the browser tool could not verify its required administrative security policy and refused access to the local preview.
- Customer visit tracking now refreshes every 30 seconds while visible, with a manual refresh action and a direct support link. Live database behavior still requires a connected test account.
