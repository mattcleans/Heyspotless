"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOpsStore, getRepository } from "@/lib/data";
import { parseCustomer, parseJob, parseProperty, type Fields } from "@/lib/data/validate";
import { PriceBookError, buildQuote } from "@/lib/pricing/quote";

/**
 * Server actions for the customer surfaces.
 *
 * Each one does the same three things in the same order: check the caller is
 * an admin, validate, write. The role check is here rather than left to
 * middleware because middleware is a convenience boundary — it decides what to
 * render, not what may be written. The real enforcement is row-level security
 * underneath, which is why these go through getOpsStore() and its
 * request-scoped client rather than the service role.
 */
export interface FormState {
  errors?: Record<string, string>;
  message?: string;
  /**
   * What the operator typed, echoed back on failure.
   *
   * The inputs are uncontrolled, so React resets each one to its defaultValue
   * when the action's result re-renders the form — which, without this, throws
   * away everything they had entered every time one field was wrong.
   */
  values?: Fields;
}

/** FormData is an iterable of entries; validate.ts wants a plain object. */
function fieldsOf(form: FormData): Fields {
  const fields: Fields = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

async function requireAdmin(): Promise<FormState | null> {
  const repo = await getRepository();
  // Demo mode has no auth at all — that is what lets the app be reviewed with
  // no credentials, and it is already how middleware treats every surface.
  if (repo.isDemo) return null;

  const profile = await repo.getCurrentProfile();
  if (!profile) return { message: "Your session has expired. Sign in again." };
  if (profile.role !== "admin") return { message: "Only an admin can do that." };
  return null;
}

export async function createCustomer(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const fields = fieldsOf(form);
  const parsed = parseCustomer(fields);
  if (!parsed.ok) return { errors: parsed.errors, values: fields };

  let id: string;
  try {
    const customer = await (await getOpsStore()).createCustomer(parsed.value);
    id = customer.id;
  } catch (error) {
    return { message: messageOf(error), values: fields };
  }

  revalidatePath("/admin/customers");
  // Outside the try: redirect() signals by throwing, and catching it here would
  // turn a successful save into an error message.
  redirect(`/admin/customers/${id}`);
}

export async function updateCustomer(
  customerId: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const fields = fieldsOf(form);
  const parsed = parseCustomer(fields);
  if (!parsed.ok) return { errors: parsed.errors, values: fields };

  try {
    await (await getOpsStore()).updateCustomer(customerId, parsed.value);
  } catch (error) {
    return { message: messageOf(error), values: fields };
  }

  revalidatePath(`/admin/customers/${customerId}`);
  return { message: "Saved." };
}

export async function createProperty(
  customerId: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const fields = fieldsOf(form);
  const parsed = parseProperty({ ...fields, customerId });
  if (!parsed.ok) return { errors: parsed.errors, values: fields };

  try {
    await (await getOpsStore()).createProperty(parsed.value);
  } catch (error) {
    return { message: messageOf(error), values: fields };
  }

  revalidatePath(`/admin/customers/${customerId}`);
  return { message: "Property added." };
}

/**
 * Book a clean.
 *
 * The price is computed here, not accepted from the form. buildQuote is given
 * the property's STORED room counts, so what the customer is charged comes from
 * the price book and the record — a total posted by the browser is a total the
 * browser could have edited. It also means the ticket price and the estimated
 * minutes the dispatch engine reasons about come from the same call, and cannot
 * disagree.
 */
export async function bookJob(
  customerId: string,
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const fields = fieldsOf(form);
  const parsed = parseJob(fields);
  if (!parsed.ok) return { errors: parsed.errors, values: fields };

  const repo = await getRepository();
  const property = await repo.getProperty(parsed.value.propertyId);
  // RLS returns nothing for a property that is not readable, so this covers
  // both "no such property" and "not yours".
  if (!property || property.customerId !== customerId) {
    return { errors: { propertyId: "That property could not be found." }, values: fields };
  }

  let priceCents: number;
  let estimatedCleanMinutes: number;
  try {
    const quote = buildQuote(parsed.value.service, parsed.value.frequency, property.rooms);
    priceCents = quote.totalCents;
    estimatedCleanMinutes = quote.estimatedMinutes;
  } catch (error) {
    // parseJob already rejects a pair the price book does not sell; this is the
    // backstop for anything else the price book refuses to quote, and it must
    // never fall through to booking a job at $0.
    if (error instanceof PriceBookError) {
      return { errors: { frequency: error.message }, values: fields };
    }
    return { message: messageOf(error), values: fields };
  }

  try {
    await (await getOpsStore()).createJob({
      input: parsed.value,
      customerId,
      priceCents,
      estimatedCleanMinutes,
    });
  } catch (error) {
    return { message: messageOf(error), values: fields };
  }

  revalidatePath(`/admin/customers/${customerId}`);
  revalidatePath("/admin/dispatch");
  return { message: "Clean booked." };
}

/**
 * What to tell the operator when the write itself failed. The underlying
 * message can name columns and constraints, which is useful in a log and
 * noise on a form.
 */
function messageOf(error: unknown): string {
  console.error("customer action failed", error);
  return "Could not save that. Please try again.";
}
