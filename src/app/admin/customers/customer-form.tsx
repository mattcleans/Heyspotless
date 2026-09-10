"use client";

import { useActionState } from "react";
import { Field, FormError, SubmitButton, TextArea } from "@/components/form";
import type { Customer } from "@/lib/data/types";
import { createCustomer, updateCustomer, type FormState } from "./actions";

/**
 * One form for both creating and editing, because the fields and the rules are
 * identical — parseCustomer does not care which it is. Passing an existing
 * customer switches the action and prefills the inputs.
 */
export function CustomerForm({ customer }: { customer?: Customer }) {
  const action = customer ? updateCustomer.bind(null, customer.id) : createCustomer;
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  // A rejected submission comes back with what was typed, so nothing the
  // operator entered is lost; falling back to the stored customer keeps the
  // edit form prefilled on first render.
  const was = state.values;

  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state.message} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="firstName"
          label="First name"
          required
          errors={state.errors}
          defaultValue={was?.["firstName"] ?? customer?.firstName}
        />
        <Field
          name="lastName"
          label="Last name"
          required
          errors={state.errors}
          defaultValue={was?.["lastName"] ?? customer?.lastName}
        />
        <Field
          name="email"
          label="Email"
          type="email"
          inputMode="email"
          errors={state.errors}
          defaultValue={was?.["email"] ?? customer?.email}
        />
        <Field
          name="phone"
          label="Phone"
          inputMode="tel"
          placeholder="(972) 555-0134"
          hint="Stored as digits so an inbound text can be matched to them."
          errors={state.errors}
          defaultValue={was?.["phone"] ?? customer?.phone}
        />
      </div>

      {/*
        Falling back to the stored notes matters more here than on the other
        fields. `updateCustomer` writes every column, so an empty textarea is
        indistinguishable from "clear the notes" — and the textarea WAS always
        empty, because this defaulted to the rejected submission and nothing
        else. Editing a phone number wiped the notes. Prefilled, an empty box
        once again means what it says, and clearing notes on purpose still works.
      */}
      <TextArea
        name="notes"
        label="Notes"
        defaultValue={was?.["notes"] ?? customer?.notes ?? ""}
        hint="Anything the office should know before quoting or scheduling."
        errors={state.errors}
      />

      <div className="flex items-center gap-3">
        <SubmitButton>{customer ? "Save changes" : "Create customer"}</SubmitButton>
        {state.message && !state.errors ? (
          <span className="text-sm text-good">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
