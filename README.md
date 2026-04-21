# Hey Spotless — Yelp Lead Responder (Claude Code, Remote)

A Claude Code agent routine that detects new Yelp leads via the Gmail API and responds to
them via headless Playwright on biz.yelp.com. Designed to run on a remote server with no
GUI — no desktop, no browser extension, no user present.

Run manually:
```bash
claude --print "Run the Yelp lead responder for Hey Spotless"
```

Or trigger on a schedule (see Scheduling section).

---

## Why Not the Yelp API?

Yelp's public Fusion API covers business search and reviews only — it has no endpoints for
the business inbox, quote requests, or messaging. There is no public API for sending lead
responses.

If Hey Spotless is on a paid Yelp advertising plan, contact Yelp partner support to ask
about webhook access for lead events. Otherwise, the approach below is the most reliable
alternative: Gmail API as the event trigger + headless Playwright to send replies.

---

## Architecture

```
Yelp new lead
     │
     ▼
Yelp sends email to hey@heyspotless.com
     │
     ▼
Gmail API — search for unread Yelp lead emails
     │
     ▼
Parse lead details from email body
(customer name, home size, service type)
     │
     ▼
Claude API — generate brand-voice response with correct pricing
     │
     ▼
Headless Playwright — log into biz.yelp.com, open lead, send reply
     │
     ▼
Log result to leads-responded.json + stdout summary
```

Everything runs headlessly. No Chrome extension, no display server, no user interaction
required after initial setup.

---

## Setup

### 1. Directory structure

```
~/hey-spotless/
  yelp-lead-responder.js     # main script
  scripts/gmail-oauth.js     # one-time OAuth helper (localhost callback)
  test/unit.test.js          # zero-dep tests for parser + pricing
  yelp-auth.json             # saved Playwright session (gitignored)
  leads-responded.json       # log of responded leads
  debug/                     # screenshots + HTML dumps on failure (gitignored)
  .env                       # secrets (gitignored)
```

### 2. Install dependencies

```bash
npm install
npx playwright install chromium --with-deps
```

The `--with-deps` flag installs system-level Chromium dependencies needed on Linux servers
(Ubuntu/Debian). Skip on macOS.

### 3. Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in the values:

```env
ANTHROPIC_API_KEY=sk-ant-...

# Yelp Business credentials
YELP_EMAIL=matthewrufca@gmail.com
YELP_PASSWORD=...

# Gmail API OAuth2 (for reading hey@heyspotless.com or the Gmail that receives Yelp emails)
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_TARGET_ADDRESS=hey@heyspotless.com

# Yelp business ID (the UUID-ish string in biz.yelp.com/leads_center/<ID>/leads)
YELP_BIZ_ID=

# Paths
LEADS_LOG=./leads-responded.json
YELP_AUTH_STATE=./yelp-auth.json
DEBUG_DIR=./debug
```

### 4. Gmail OAuth2 setup (one-time)

You need a refresh token that gives the script read/modify access to the inbox that
receives Yelp notification emails.

1. Go to console.cloud.google.com → create a project → enable the Gmail API
2. Create an OAuth2 credential of type **Web application**. Add
   `http://localhost:8765/oauth2callback` as an authorized redirect URI.
3. Put the client ID and secret in `.env`, then run:

```bash
node scripts/gmail-oauth.js
```

It prints a URL. Open it, approve, and the script prints the refresh token. Paste that
into `GMAIL_REFRESH_TOKEN` in `.env`.

> The old "OOB" flow (`urn:ietf:wg:oauth:2.0:oob`) that many tutorials show was
> deprecated by Google in 2022 and no longer works for new OAuth clients. The helper
> above uses a real localhost redirect instead.

### 5. Yelp session bootstrap (one-time, run locally then copy to server)

```bash
npx playwright codegen \
  --save-storage=./yelp-auth.json \
  https://biz.yelp.com/login
```

This opens a browser. Log in to biz.yelp.com as Hey Spotless, then close the browser.
The session cookies are saved to `yelp-auth.json`. Copy this file to the remote server.
Re-run this step if Yelp logs you out (typically every 30–90 days).

---

## Troubleshooting Without a Live Lead

The script has four modes you can use before any real customer email arrives:

```bash
# 1. Verify every dependency independently (env vars, Anthropic, Gmail, Yelp session).
#    Prints a pass/fail table and exits non-zero if anything is broken.
node yelp-lead-responder.js --doctor

# 2. Run the parser + Claude call against a built-in sample email. No Gmail, no Yelp.
#    Good for validating tone and the pricing calculation end-to-end.
node yelp-lead-responder.js --sample

# 3. Dump the most recent unread Yelp-matching email from Gmail, without marking read.
#    Shows the parsed fields so you can see what the parser is picking up.
node yelp-lead-responder.js --dump-email

# 4. Full pipeline but stops one click short of pressing Send. Drops a pre-send
#    screenshot into ./debug/ so you can eyeball the composed reply in Yelp's UI.
node yelp-lead-responder.js --dry-run

# Unit tests (zero deps beyond node).
node test/unit.test.js
```

**Failure diagnostics.** Any Playwright failure drops three files into `./debug/`:
`<label>-<timestamp>.png` (screenshot), `.html` (page source), and `.url` (landing URL).
That's usually enough to update selectors without rerunning.

**Known failure modes and what they mean:**

| Error | Cause | Fix |
|---|---|---|
| `Yelp session expired or blocked` | `yelp-auth.json` cookies rotated, or headless Chromium flagged | Re-run `playwright codegen` on a workstation, copy the fresh `yelp-auth.json` over |
| `Could not find any lead in the inbox list` | Selectors drifted or you landed on a non-leads page | Open the screenshot, grab the new selector, prepend to the array in `firstMatch` |
| `Could not find message input field` | Yelp changed the compose UI | Same — inspect the HTML dump, add the new selector |
| Gmail returns 0 emails but you know one exists | Subject/from filter too narrow | Loosen `q` in `getNewYelpLeadEmails`, or use `--dump-email` to see what Gmail returns |

## Running as a Claude Code Agent

When invoked via Claude Code (`claude --print "Run the Yelp lead responder..."`), the
agent should:

1. `cd ~/hey-spotless`
2. Run `node yelp-lead-responder.js`
3. Read stdout and report results
4. If Playwright fails with a selector error, take a screenshot of the page state, save it
   to `./debug-[timestamp].png`, and report it — this means Yelp's UI has changed and
   the selectors need updating

The agent should NOT ask clarifying questions. Run the script, report what happened,
flag any errors.

---

## Scheduling

### cron (simple)

```bash
crontab -e
# Add: run every 30 minutes
*/30 * * * * cd ~/hey-spotless && node yelp-lead-responder.js >> /tmp/yelp-leads.log 2>&1
```

### If running on a remote Linux server, install Chromium dependencies first

```bash
npx playwright install-deps chromium
```

---

## Handling Selector Drift

Yelp's UI changes occasionally and will break Playwright selectors. When this happens:

1. The script logs `Failed: Could not find message input field` (or similar)
2. Run `node yelp-lead-responder.js` with `headless: false` temporarily to see the page
3. Use `await page.pause()` before the failing step to inspect the DOM
4. Update the selector arrays in the script and re-run
5. Switch back to `headless: true`

To make the agent resilient, the selectors are stored as arrays — the script tries each
one in order. Add new selectors to the front of each array when Yelp updates.

---

## Yelp Partner API (Future)

If Hey Spotless joins a Yelp advertising plan, contact Yelp's advertiser support and ask
specifically about:
- **Lead notifications via webhook** — event push when a new "Request a Quote" comes in
- **Yelp Ads API** — some advertiser accounts have programmatic access to lead data

If a webhook endpoint becomes available, replace the Gmail polling step with a small
Express server that receives `POST /yelp-lead` events, then calls `generateResponse()` and
`sendYelpReply()` directly. This would reduce response time from ~30 minutes to under 60
seconds.

---

## Business Reference

| Field | Value |
|---|---|
| Business | Hey Spotless |
| Owners | Matt & Maddie |
| Area | Dallas-Fort Worth (~35mi of Irving, TX) |
| Phone | (469) 280-0397 |
| Email | hey@heyspotless.com |
| Booking | www.heyspotless.com |
| Hours | Mon–Sat 8am–6pm (Sun by appt) |

Pricing formula: `(beds × 32.50) + (baths × 20) + 72.50` = standard rate.
Deep clean = standard × 1.75. Move-in/out = standard × 2.0.
Recurring discounts: weekly −20%, bi-weekly −15%, monthly −10%.
