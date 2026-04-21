#!/usr/bin/env node
// One-time helper to obtain a Gmail refresh token.
//
// Prerequisites:
//   - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set in .env (or exported).
//   - The OAuth client must be configured as "Web application" in the Google
//     Cloud console, with http://localhost:8765/oauth2callback listed as an
//     authorized redirect URI.
//
// Usage:
//   node scripts/gmail-oauth.js
//   → opens a URL; after you approve, the refresh token is printed.
//   → copy it into GMAIL_REFRESH_TOKEN in your .env.

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force refresh_token in the response
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400); res.end('Missing code'); return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Success — you can close this tab. Refresh token printed in your terminal.');
    console.log('\nRefresh token:\n');
    console.log(tokens.refresh_token || '(none — did you already approve this app? Revoke access at https://myaccount.google.com/permissions and re-run.)');
    console.log('\nPaste this into GMAIL_REFRESH_TOKEN in .env\n');
  } catch (e) {
    res.writeHead(500); res.end('Token exchange failed: ' + e.message);
    console.error(e);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(PORT, () => {
  console.log(`\nListening on ${REDIRECT}\n`);
  console.log('Open this URL in your browser and approve:\n');
  console.log(authUrl + '\n');
});
