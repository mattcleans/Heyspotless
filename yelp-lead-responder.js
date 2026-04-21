require('dotenv').config();
const { chromium } = require('playwright');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const LEADS_LOG = process.env.LEADS_LOG || './leads-responded.json';
const AUTH_STATE = process.env.YELP_AUTH_STATE || './yelp-auth.json';
const YELP_BIZ_ID = process.env.YELP_BIZ_ID || '';
const DEBUG_DIR = process.env.DEBUG_DIR || './debug';

const FLAGS = new Set(process.argv.slice(2));
const DRY_RUN = FLAGS.has('--dry-run');
const DOCTOR = FLAGS.has('--doctor');
const DUMP_EMAIL = FLAGS.has('--dump-email');
const SAMPLE = FLAGS.has('--sample');

// ── Pricing ──────────────────────────────────────────────────────────────────

function calcPrice(beds, baths, type = 'standard', frequency = null) {
  const base = (beds * 32.5) + (baths * 20) + 72.5;
  let price = type === 'deep'     ? base * 1.75
            : type === 'moveout'  ? base * 2.0
            : base;
  if (frequency === 'weekly')     price *= 0.80;
  if (frequency === 'biweekly')   price *= 0.85;
  if (frequency === 'monthly')    price *= 0.90;
  return Math.round(price);
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

function gmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function getNewYelpLeadEmails({ markRead = true } = {}) {
  const gmail = gmailClient();

  // Parenthesize the OR so it only scopes subjects, not the entire query.
  // Yelp sends from multiple @yelp.com sub-addresses, so keep the from filter broad.
  const q = 'from:(@yelp.com) is:unread (subject:(quote) OR subject:(request) OR subject:(lead) OR subject:(new message))';

  const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
  const messages = res.data.messages || [];
  const leads = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });
    const headers = indexHeaders(full.data.payload?.headers || []);
    const body = extractBody(full.data.payload);
    const parsed = parseLead(body, headers);
    leads.push({ gmailId: msg.id, subject: headers.subject, from: headers.from, body, parsed });

    if (markRead) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    }
  }
  return leads;
}

function indexHeaders(headers) {
  const out = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

// Recursively walk the MIME tree. Prefer text/plain, fall back to stripped HTML.
function extractBody(payload) {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain) return decodePart(plain);
  const html = findPart(payload, 'text/html');
  if (html) return htmlToText(decodePart(html));
  return '';
}

function findPart(payload, mimeType) {
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const p of payload.parts || []) {
    const found = findPart(p, mimeType);
    if (found) return found;
  }
  return null;
}

function decodePart(part) {
  // Gmail API uses base64url (RFC 4648 §5), not standard base64.
  const data = (part.body?.data || '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(data, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Pull structured fields out of the Yelp email body. All fields are optional;
// downstream code handles nulls gracefully.
function parseLead(body, headers = {}) {
  const out = { name: null, beds: null, baths: null, serviceType: null, frequency: null, zip: null };
  if (!body) return out;

  const nameMatch = body.match(/(?:from|name[:\s]+)([A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) out.name = nameMatch[1].trim();

  const bedsMatch = body.match(/(\d+)\s*(?:bed|bedroom|br\b)/i);
  if (bedsMatch) out.beds = parseInt(bedsMatch[1], 10);

  const bathsMatch = body.match(/(\d+(?:\.\d+)?)\s*(?:bath|bathroom|ba\b)/i);
  if (bathsMatch) out.baths = parseFloat(bathsMatch[1]);

  if (/deep\s*clean/i.test(body)) out.serviceType = 'deep';
  else if (/move[-\s]?(in|out)/i.test(body)) out.serviceType = 'moveout';
  else if (/standard|regular|routine/i.test(body)) out.serviceType = 'standard';

  // Check biweekly variants before 'weekly' — "bi-weekly" contains "weekly".
  if (/bi[-\s]?weekly|every\s+other\s+week|every\s+2\s+weeks/i.test(body)) out.frequency = 'biweekly';
  else if (/weekly/i.test(body)) out.frequency = 'weekly';
  else if (/monthly|once\s+a\s+month/i.test(body)) out.frequency = 'monthly';

  const zip = body.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip) out.zip = zip[1];

  return out;
}

// ── Response generation ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are drafting a reply for Matt & Maddie, co-owners of Hey Spotless,
a residential cleaning company in the Dallas-Fort Worth area.

Pricing formula (round to nearest dollar):
- Standard = (beds × 32.50) + (baths × 20) + 72.50
- Deep clean = Standard × 1.75
- Move-in/out = Standard × 2.00
- Recurring: weekly −20%, bi-weekly −15%, monthly −10%

Brand voice: warm, concise, like a helpful neighbor — not a call center.
Always signed "Matt & Maddie / Co-owners | Hey Spotless / (469) 280-0397".
If home size is unknown, skip the price and send them to www.heyspotless.com for an instant quote.
Output ONLY the ready-to-send message. No commentary.`;

async function generateResponse(emailBody, parsed = null) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const hint = parsed
    ? `\n\nParsed fields (may be incomplete): ${JSON.stringify(parsed)}`
    : '';
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `New Yelp lead email:\n\n${emailBody}${hint}` }],
  });
  return msg.content[0].text.trim();
}

// ── Yelp Playwright ───────────────────────────────────────────────────────────

function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

async function dumpPage(page, label) {
  ensureDebugDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(DEBUG_DIR, `${label}-${stamp}`);
  try { await page.screenshot({ path: `${base}.png`, fullPage: true }); } catch {}
  try { fs.writeFileSync(`${base}.html`, await page.content()); } catch {}
  try { fs.writeFileSync(`${base}.url`, page.url()); } catch {}
  return base;
}

// Try a list of selectors; return the first locator that has ≥1 match.
async function firstMatch(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    if (await loc.count() > 0) return { locator: loc.first(), selector: sel };
  }
  return null;
}

function leadsInboxUrl() {
  if (YELP_BIZ_ID) return `https://biz.yelp.com/leads_center/${YELP_BIZ_ID}/leads`;
  // Fallback: biz.yelp.com will redirect to the correct business if logged in.
  return 'https://biz.yelp.com/messaging';
}

async function sendYelpReply({ customerName, replyText, dryRun = false }) {
  const storageState = fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    storageState,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  // Remove the webdriver flag that headless Chromium leaks.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(leadsInboxUrl(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Bail early on login/CAPTCHA; auto-filling credentials in headless mode
    // reliably triggers Yelp's bot defenses.
    const url = page.url();
    const loggedOut = url.includes('/login') || url.includes('/signup');
    const captcha = await page.locator('iframe[src*="captcha"], iframe[title*="captcha" i]').count();
    if (loggedOut || captcha > 0) {
      const dump = await dumpPage(page, 'auth-required');
      throw new Error(
        `Yelp session expired or blocked (url=${url}, captcha=${captcha}). ` +
        `Re-run 'npx playwright codegen --save-storage=./yelp-auth.json https://biz.yelp.com/login' ` +
        `on a workstation and copy yelp-auth.json to this host. Dump: ${dump}`
      );
    }

    // Find the lead. Prefer matching by customer name; fall back to first "New".
    let leadEntry = null;
    if (customerName) {
      const byName = page.locator(`text=/${escapeRegex(customerName)}/i`).first();
      if (await byName.count() > 0) leadEntry = { locator: byName, selector: `text=/${customerName}/i` };
    }
    if (!leadEntry) {
      leadEntry = await firstMatch(page, [
        '[data-testid="lead-new"]',
        '.lead-new',
        '[aria-label*="New lead" i]',
        '[data-testid="lead-item"]',
        '.lead-item',
      ]);
    }
    if (!leadEntry) {
      await dumpPage(page, 'no-lead-entry');
      throw new Error('Could not find any lead in the inbox list');
    }
    await leadEntry.locator.click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // Optional: open the quote-reply flow if that button is present.
    const quoteBtn = await firstMatch(page, [
      'button:has-text("Send price")',
      'button:has-text("Send Price")',
      '[data-testid="send-price-button"]',
      'button:has-text("Reply with quote")',
    ]);
    if (quoteBtn) {
      await quoteBtn.locator.click();
      await page.waitForTimeout(1000);
    }

    const input = await firstMatch(page, [
      'textarea[placeholder*="message" i]',
      'textarea[name*="message" i]',
      '[data-testid="message-input"]',
      '.reply-textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ]);
    if (!input) {
      await dumpPage(page, 'no-input');
      throw new Error('Could not find message input field');
    }
    await input.locator.fill(replyText);

    // Take a pre-send screenshot for verification and for dry-run preview.
    const preview = await dumpPage(page, dryRun ? 'dry-run-preview' : 'pre-send');

    if (dryRun) {
      return { success: true, dryRun: true, preview, matchedSelector: input.selector };
    }

    const sendBtn = await firstMatch(page, [
      '[data-testid="send-button"]',
      'button[type="submit"]:has-text("Send")',
      'button:has-text("Send message")',
      'button:has-text("Send")',
    ]);
    if (!sendBtn) {
      await dumpPage(page, 'no-send-button');
      throw new Error('Could not find Send button');
    }
    await sendBtn.locator.click();
    await page.waitForTimeout(2500);
    return { success: true, preview };
  } catch (err) {
    let dump = null;
    try { dump = await dumpPage(page, 'error'); } catch {}
    return { success: false, error: err.message, dump };
  } finally {
    await browser.close();
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Leads log ─────────────────────────────────────────────────────────────────

function loadLog() {
  if (!fs.existsSync(LEADS_LOG)) return [];
  try { return JSON.parse(fs.readFileSync(LEADS_LOG, 'utf-8')); }
  catch { return []; }
}

function saveLog(log) {
  fs.writeFileSync(LEADS_LOG, JSON.stringify(log, null, 2));
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

const SAMPLE_EMAIL = `
You have a new quote request from Sarah Johnson on Yelp.

Service requested: Deep clean
Home size: 3 bedrooms, 2 bathrooms
Frequency: One-time
ZIP: 75061

Message: "Hi, I just moved in and the place needs a serious scrub.
Looking to get it done before next weekend if possible. Thanks!"
`.trim();

async function doctor() {
  const checks = [];
  const mark = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. Env vars
  const required = ['ANTHROPIC_API_KEY', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  for (const k of required) mark(`env ${k}`, Boolean(process.env[k]), process.env[k] ? 'set' : 'MISSING');
  mark('env YELP_BIZ_ID', Boolean(YELP_BIZ_ID), YELP_BIZ_ID || 'MISSING (will use /messaging fallback)');
  mark('file yelp-auth.json', fs.existsSync(AUTH_STATE), AUTH_STATE);

  // 2. Anthropic reachable
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
    });
    mark('anthropic api', true, r.content[0].text.slice(0, 30));
  } catch (e) {
    mark('anthropic api', false, e.message);
  }

  // 3. Gmail reachable
  try {
    const gmail = gmailClient();
    const prof = await gmail.users.getProfile({ userId: 'me' });
    mark('gmail api', true, prof.data.emailAddress);
  } catch (e) {
    mark('gmail api', false, e.message);
  }

  // 4. Playwright launch + Yelp reachable (no send)
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({
      storageState: fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined,
    });
    const page = await ctx.newPage();
    await page.goto(leadsInboxUrl(), { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    const authed = !url.includes('/login') && !url.includes('/signup');
    await browser.close();
    mark('yelp session', authed, `landed on ${url}`);
  } catch (e) {
    mark('yelp session', false, e.message);
  }

  console.log('\nDiagnostics:\n');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(24)} ${c.detail}`);
  }
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

async function dumpLatestEmail() {
  const leads = await getNewYelpLeadEmails({ markRead: false });
  if (!leads.length) {
    console.log('No unread Yelp-matching emails found. Try sending yourself one from a test address.');
    return;
  }
  for (const l of leads) {
    console.log(`\n── ${l.subject} (${l.from}) [id=${l.gmailId}] ──`);
    console.log('Parsed:', l.parsed);
    console.log('Body:\n' + l.body.slice(0, 2000));
    console.log(l.body.length > 2000 ? '...[truncated]' : '');
  }
}

async function runSample() {
  console.log('Running against the built-in sample email (no Gmail, no Yelp send).');
  const parsed = parseLead(SAMPLE_EMAIL);
  console.log('Parsed fields:', parsed);
  const reply = await generateResponse(SAMPLE_EMAIL, parsed);
  console.log('\n── Generated reply ──');
  console.log(reply);
  console.log('─────────────────────');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DOCTOR) return doctor();
  if (DUMP_EMAIL) return dumpLatestEmail();
  if (SAMPLE) return runSample();

  console.log(`\nHey Spotless Yelp Lead Responder — ${new Date().toISOString()}${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const log = loadLog();
  // Don't mark-read in dry-run so you can re-test.
  const emails = await getNewYelpLeadEmails({ markRead: !DRY_RUN });

  if (emails.length === 0) {
    console.log('   No new Yelp lead emails found. Done.');
    return;
  }

  console.log(`   Found ${emails.length} new lead email(s). Processing...`);
  let responded = 0;

  for (const { gmailId, body, parsed } of emails) {
    if (log.find(l => l.gmailId === gmailId)) {
      console.log(`   Skipping already-processed email ${gmailId}`);
      continue;
    }

    console.log(`   Parsed:`, parsed);
    const reply = await generateResponse(body, parsed);
    console.log(`\n   Draft response:\n${'─'.repeat(60)}\n${reply}\n${'─'.repeat(60)}`);

    const result = await sendYelpReply({
      customerName: parsed?.name,
      replyText: reply,
      dryRun: DRY_RUN,
    });

    const entry = { timestamp: new Date().toISOString(), gmailId, parsed, reply, ...result };
    if (!DRY_RUN) {
      log.push(entry);
      saveLog(log);
    }

    if (result.success) {
      console.log(DRY_RUN ? `   ✅ Dry run OK (preview: ${result.preview})` : '   ✅ Sent successfully');
      responded++;
    } else {
      console.log(`   ❌ Failed: ${result.error}`);
      if (result.dump) console.log(`   Debug dump: ${result.dump}.{png,html,url}`);
    }
  }

  console.log(`\n   Summary: ${responded}/${emails.length} lead(s) ${DRY_RUN ? 'previewed' : 'responded to'}.\n`);
}

module.exports = {
  calcPrice,
  parseLead,
  extractBody,
  generateResponse,
  sendYelpReply,
  getNewYelpLeadEmails,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
