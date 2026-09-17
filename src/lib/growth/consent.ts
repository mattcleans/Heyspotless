import { CUSTOMER_BRAND } from "../brand";

/**
 * The exact words somebody agreed to.
 *
 * A2P 10DLC requires express written consent before texting a number typed into
 * a web form, and what has to be kept is not a boolean — it is the language
 * that was on the screen and the moment it was ticked. The same shape as
 * autopay consent in 0006: a checkbox is a UI state, a timestamp against the
 * wording is evidence.
 *
 * STORED PER LEAD, NOT REFERENCED. `leads.sms_consent_text` holds a copy of
 * this string rather than a version number pointing at it, because this
 * constant will change and the consent somebody gave in September must not
 * silently become the consent they gave to next year's wording.
 */
export const SMS_CONSENT_TEXT =
  `Text me about this booking. ${CUSTOMER_BRAND} will send appointment ` +
  `confirmations, reminders and replies to this number. Message and data rates ` +
  `may apply; message frequency varies. Reply STOP to opt out, HELP for help.`;

/**
 * The same evidence, for somebody applying to clean rather than to book.
 *
 * A separate string because it describes different traffic — she will be texted
 * about job offers with countdowns on them, not about appointments — and
 * because the consent somebody gave as an applicant should read like what it
 * was if it is ever produced.
 */
export const APPLICANT_SMS_CONSENT_TEXT =
  `Text me about this application and about work. ${CUSTOMER_BRAND} will send ` +
  `updates on your application and, once you are active, job offers with the ` +
  `pay and the time on them. Message and data rates may apply; message ` +
  `frequency varies. Reply STOP to opt out, HELP for help.`;
