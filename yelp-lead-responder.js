require('dotenv').config();
const { chromium } = require('playwright');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const LEADS_LOG = process.env.LEADS_LOG || './leads-responded.json';
const AUTH_STATE = process.env.YELP_AUTH_STATE || './yelp-auth.json';

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

async function getNewYelpLeadEmails() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:yelp.com is:unread subject:quote OR subject:request',
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  const leads = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id });
    const body = extractBody(full.data);
    leads.push({ gmailId: msg.id, body });

    // Mark read immediately so we don't reprocess on the next run
    await gmail.users.messages.modify({
      userId: 'me',
      id: msg.id,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  }

  return leads;
}

function extractBody(message) {
  const parts = message.payload.parts || [message.payload];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  }
  return '';
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

async function generateResponse(emailBody) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `New Yelp lead email:\n\n${emailBody}` }],
  });
  return msg.content[0].text.trim();
}

// ── Yelp Playwright ───────────────────────────────────────────────────────────

async function sendYelpReply(customerIdentifier, replyText) {
  const storageState = fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState });
  const page = await ctx.newPage();

  try {
    // Navigate to leads inbox
    await page.goto('https://biz.yelp.com/leads_center/yGjeNCX8yf57W5glM3ENhw/leads', {
      waitUntil: 'networkidle',
    });

    // If redirected to login page, re-authenticate
    if (page.url().includes('/login')) {
      await page.fill('input[name="email"]', process.env.YELP_EMAIL);
      await page.fill('input[name="password"]', process.env.YELP_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle' });
      // Save updated auth state for next run
      await ctx.storageState({ path: AUTH_STATE });
    }

    // Find the lead matching the customer (by name or "New" badge)
    // First try: click on a lead with "New" indicator
    const newLeadSelector = '[data-testid="lead-new"], .lead-new, [aria-label*="New"]';
    const firstNew = page.locator(newLeadSelector).first();
    if (await firstNew.count() > 0) {
      await firstNew.click();
    } else {
      // Fallback: click the first lead in the list
      await page.locator('.lead-item, [data-testid="lead-item"]').first().click();
    }

    await page.waitForTimeout(1500);

    // Try the "Send price & availability" button first (Yelp quote flow)
    const quoteBtnSelectors = [
      'button:has-text("Send price")',
      'button:has-text("Send Price")',
      '[data-testid="send-price-button"]',
    ];
    let usedQuoteFlow = false;
    for (const sel of quoteBtnSelectors) {
      if (await page.locator(sel).count() > 0) {
        await page.locator(sel).click();
        await page.waitForTimeout(1000);
        usedQuoteFlow = true;
        break;
      }
    }

    // Type the reply message
    const replySelectors = [
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      '[data-testid="message-input"]',
      '.reply-textarea',
      'div[contenteditable="true"]',
    ];
    let typed = false;
    for (const sel of replySelectors) {
      if (await page.locator(sel).count() > 0) {
        await page.locator(sel).fill(replyText);
        typed = true;
        break;
      }
    }
    if (!typed) throw new Error('Could not find message input field');

    // Click send
    const sendSelectors = [
      'button:has-text("Send")',
      'button[type="submit"]:has-text("Send")',
      '[data-testid="send-button"]',
    ];
    let sent = false;
    for (const sel of sendSelectors) {
      if (await page.locator(sel).count() > 0) {
        await page.locator(sel).click();
        sent = true;
        break;
      }
    }
    if (!sent) throw new Error('Could not find Send button');

    await page.waitForTimeout(2000);
    return { success: true };

  } catch (err) {
    try {
      const shot = `./debug-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      return { success: false, error: err.message, screenshot: shot };
    } catch {
      return { success: false, error: err.message };
    }
  } finally {
    await browser.close();
  }
}

// ── Leads log ─────────────────────────────────────────────────────────────────

function loadLog() {
  if (!fs.existsSync(LEADS_LOG)) return [];
  return JSON.parse(fs.readFileSync(LEADS_LOG, 'utf-8'));
}

function saveLog(log) {
  fs.writeFileSync(LEADS_LOG, JSON.stringify(log, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧹 Hey Spotless Yelp Lead Responder — ${new Date().toISOString()}`);

  const log = loadLog();
  const emails = await getNewYelpLeadEmails();

  if (emails.length === 0) {
    console.log('   No new Yelp lead emails found. Done.');
    return;
  }

  console.log(`   Found ${emails.length} new lead email(s). Processing...`);
  let responded = 0;

  for (const { gmailId, body } of emails) {
    // Skip if already responded (by gmail ID)
    if (log.find(l => l.gmailId === gmailId)) {
      console.log(`   Skipping already-processed email ${gmailId}`);
      continue;
    }

    const reply = await generateResponse(body);
    console.log(`\n   Draft response:\n${'─'.repeat(60)}\n${reply}\n${'─'.repeat(60)}`);

    const result = await sendYelpReply(gmailId, reply);

    const entry = {
      timestamp: new Date().toISOString(),
      gmailId,
      reply,
      ...result,
    };
    log.push(entry);
    saveLog(log);

    if (result.success) {
      console.log('   ✅ Sent successfully');
      responded++;
    } else {
      console.log(`   ❌ Failed: ${result.error}`);
      if (result.screenshot) console.log(`   Screenshot: ${result.screenshot}`);
    }
  }

  console.log(`\n   Summary: ${responded}/${emails.length} lead(s) responded to.\n`);
}

module.exports = { calcPrice, generateResponse, sendYelpReply, getNewYelpLeadEmails };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
