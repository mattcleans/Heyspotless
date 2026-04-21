// Lightweight zero-dep tests for the pure logic in yelp-lead-responder.js.
// Run with: node test/unit.test.js

const assert = require('node:assert/strict');
const { calcPrice, parseLead, extractBody } = require('../yelp-lead-responder.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log('\ncalcPrice');
t('standard 3bd/2ba', () => assert.equal(calcPrice(3, 2), Math.round(3 * 32.5 + 2 * 20 + 72.5)));
t('deep 3bd/2ba = standard × 1.75', () => {
  const base = 3 * 32.5 + 2 * 20 + 72.5;
  assert.equal(calcPrice(3, 2, 'deep'), Math.round(base * 1.75));
});
t('moveout 4bd/3ba = standard × 2', () => {
  const base = 4 * 32.5 + 3 * 20 + 72.5;
  assert.equal(calcPrice(4, 3, 'moveout'), Math.round(base * 2));
});
t('weekly applies 20% off', () => {
  const base = 2 * 32.5 + 2 * 20 + 72.5;
  assert.equal(calcPrice(2, 2, 'standard', 'weekly'), Math.round(base * 0.80));
});
t('biweekly applies 15% off', () => {
  const base = 2 * 32.5 + 2 * 20 + 72.5;
  assert.equal(calcPrice(2, 2, 'standard', 'biweekly'), Math.round(base * 0.85));
});

console.log('\nparseLead');
t('extracts beds, baths, deep service, ZIP', () => {
  const body = 'New request from Sarah Johnson. 3 bedrooms, 2 bathrooms. Deep clean. 75061.';
  const p = parseLead(body);
  assert.equal(p.beds, 3);
  assert.equal(p.baths, 2);
  assert.equal(p.serviceType, 'deep');
  assert.equal(p.zip, '75061');
});
t('recognizes biweekly variants', () => {
  assert.equal(parseLead('bi-weekly cleaning').frequency, 'biweekly');
  assert.equal(parseLead('every other week').frequency, 'biweekly');
  assert.equal(parseLead('every 2 weeks please').frequency, 'biweekly');
});
t('recognizes move-out', () => {
  assert.equal(parseLead('Need a move-out clean on the 30th').serviceType, 'moveout');
});
t('returns nulls when nothing matches', () => {
  const p = parseLead('Hello there');
  assert.equal(p.beds, null);
  assert.equal(p.baths, null);
  assert.equal(p.serviceType, null);
});
t('empty body is safe', () => {
  const p = parseLead('');
  assert.ok(p);
  assert.equal(p.name, null);
});

console.log('\nextractBody');
t('pulls text/plain from a simple payload', () => {
  const payload = {
    mimeType: 'text/plain',
    body: { data: Buffer.from('hello world').toString('base64url') },
  };
  assert.equal(extractBody(payload), 'hello world');
});
t('prefers text/plain inside multipart/alternative', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML</p>').toString('base64url') } },
      { mimeType: 'text/plain', body: { data: Buffer.from('plain text').toString('base64url') } },
    ],
  };
  assert.equal(extractBody(payload), 'plain text');
});
t('falls back to HTML, stripping tags', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<p>Hi <b>Sarah</b></p>').toString('base64url') } },
    ],
  };
  assert.match(extractBody(payload), /Hi\s+Sarah/);
});
t('handles nested multipart (mixed → alternative)', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('nested plain').toString('base64url') } },
        ],
      },
      { mimeType: 'application/pdf', body: { attachmentId: 'abc' } },
    ],
  };
  assert.equal(extractBody(payload), 'nested plain');
});
t('decodes base64url (- and _ replaced)', () => {
  // "Subject: ?" encodes to "U3ViamVjdDogPw==" in base64; base64url drops padding and
  // replaces +/ with -_ . This blob uses characters only found in base64url.
  const raw = 'hello? world>>';
  const payload = {
    mimeType: 'text/plain',
    body: { data: Buffer.from(raw).toString('base64url') },
  };
  assert.equal(extractBody(payload), raw);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
