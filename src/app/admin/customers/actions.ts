"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOpsStore, getRepository } from "@/lib/data";
import { parseCustomer, parseProperty, type Fields } from "@/lib/data/validate";

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
 * What to tell the operator when the write itself failed. The underlying
 * message can name columns and constraints, which is useful in a log and
 * noise on a form.
 */
function messageOf(error: unknown): string {
  console.error("customer action failed", error);
  return "Could not save that. Please try again.";
}
