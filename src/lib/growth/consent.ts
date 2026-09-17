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
