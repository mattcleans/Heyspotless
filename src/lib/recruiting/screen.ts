/**
 * What we ask, and what the answers are worth.
 *
 * THE QUESTIONS ARE DATA, NOT A FORM. They are stored as asked on the
 * application, keyed, so a question that changes in March does not silently
 * re-label an answer given in January. The form renders this list; the review
 * queue reads it back by key.
 *
 * NOTHING HERE DECIDES ANYTHING. There is no automatic rejection and no
 * threshold that filters somebody out of the queue — the score orders the list
 * a person works through, and that is all it does. The build plan's phase 08
 * calls this an "AI screen", and the honest version of that at this volume is a
 * ranking, because the cost of wrongly rejecting a good cleaner in a market
 * this thin is far higher than the cost of reading fifteen applications.
 */

export interface ScreenQuestion {
  key: string;
  prompt: string;
  /** What a good answer contains, for whoever reads it. Never matched on. */
  looksLike: string;
  rows: number;
}

export const SCREEN_QUESTIONS: readonly ScreenQuestion[] = [
  {
    key: "experience",
    prompt: "Tell us about your cleaning experience.",
    looksLike: "Specifics: how long, what kind of homes, on their own or for a company.",
    rows: 4,
  },
  {
    key: "difficult_customer",
    prompt: "A customer says a room was missed and you know you cleaned it. What do you do?",
    looksLike: "Goes back, does not argue. The instinct to defend the work is the thing to watch.",
    rows: 4,
  },
  {
    key: "supplies",
    prompt: "What do you bring, and what do you expect us to provide?",
    looksLike: "Anyone who owns a vacuum and knows what they use is a step ahead.",
    rows: 3,
  },
  {
    key: "availability",
    prompt: "Which days and hours can you work, and how far will you drive?",
    looksLike: "Weekday mornings are the demand. A 30-minute radius is the honest limit.",
    rows: 3,
  },
];

/**
 * A number to sort the queue by, from the parts of an application that are
 * facts rather than prose.
 *
 * DELIBERATELY CRUDE, and it should stay that way until there is enough hiring
 * history to justify anything cleverer. It says "read this one first", never
 * "hire this one" — the score is not a gate and nothing in the funnel refuses
 * an application because of it.
 *
 * The weights are the eligibility gate's own inputs, which is the only defence
 * available for choosing them: transport and a service area are things dispatch
 * will actually check, so an applicant without them is genuinely further from
 * being able to take a job.
 */
export interface ScreenInput {
  yearsExperience: number | null;
  hasVehicle: boolean | null;
  workAuthorized: boolean | null;
  hasOwnInsurance: boolean | null;
  serviceZips: readonly string[];
  answers: Record<string, string> | null;
}

export function screenScore(input: ScreenInput): number {
  let score = 0;

  // Right to work is not a preference. Without it there is nothing to discuss,
  // and the score says so rather than the funnel pretending otherwise.
  if (input.workAuthorized === false) return 0;

  // Experience, flattening out at five years: the difference between one year
  // and three is large, between eight and ten is noise.
  const years = Math.min(input.yearsExperience ?? 0, 5);
  score += (years / 5) * 30;

  // Dispatch checks both of these. An applicant without them cannot be sent to
  // a house whatever else is true.
  if (input.hasVehicle) score += 20;
  if (input.serviceZips.length > 0) score += 15;

  // Insurance is a hard gate for a contractor at activation (0024), so having
  // it already is the difference between hiring in a day and hiring in a month.
  if (input.hasOwnInsurance) score += 15;

  // Answered the questions, in sentences. Length is a poor proxy for quality
  // and an excellent one for effort, which is what this is measuring.
  const answers = Object.values(input.answers ?? {});
  const substantial = answers.filter((a) => a.trim().length >= 40).length;
  score += Math.min(substantial, 4) * 5;

  return Math.round(score);
}
