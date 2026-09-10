"use client";

import { useActionState } from "react";
import { Field, FormError, SubmitButton, TextArea } from "@/components/form";
import { createProperty, type FormState } from "./actions";

/**
 * Adding a property to a customer.
 *
 * The room counts are the load-bearing part: every quote is priced off them,
 * and the dispatch estimator keys travel off the ZIP. Half baths are their own
 * field rather than a decimal because a Zillow "2.5 ba" is two full baths and a
 * half, and the price book charges them differently.
 */
export function PropertyForm({ customerId }: { customerId: string }) {
  const action = createProperty.bind(null, customerId);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  // As in CustomerForm: echo back what was typed so a rejected submission does
  // not make the operator retype the whole address.
  const was = state.values;

  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state.message} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="street"
          label="Street"
          required
          errors={state.errors}
          defaultValue={was?.["street"]}
        />
        <Field
          name="city"
          label="City"
          required
          errors={state.errors}
          defaultValue={was?.["city"]}
        />
        <Field
          name="state"
          label="State"
          errors={state.errors}
          defaultValue={was?.["state"] ?? "TX"}
        />
        <Field
          name="zip"
          label="ZIP"
          required
          inputMode="numeric"
          placeholder="75024"
          hint="Five digits — routing estimates drive time from it."
          errors={state.errors}
          defaultValue={was?.["zip"]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field
          name="bedrooms"
          label="Bedrooms"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["bedrooms"]}
        />
        <Field
          name="bathrooms"
          label="Full baths"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["bathrooms"]}
        />
        <Field
          name="halfBaths"
          label="Half baths"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["halfBaths"]}
        />
        <Field
          name="kitchens"
          label="Kitchens"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["kitchens"] ?? 1}
        />
        <Field
          name="livingRooms"
          label="Living rooms"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["livingRooms"] ?? 1}
        />
        <Field
          name="utilityRooms"
          label="Utility rooms"
          inputMode="numeric"
          errors={state.errors}
          defaultValue={was?.["utilityRooms"] ?? 1}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="gateCode"
          label="Gate code"
          errors={state.errors}
          defaultValue={was?.["gateCode"]}
        />
        <Field
          name="pets"
          label="Pets"
          placeholder="Two cats, indoor"
          errors={state.errors}
          defaultValue={was?.["pets"]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextArea
          name="accessNotes"
          label="Access notes"
          errors={state.errors}
          defaultValue={was?.["accessNotes"]}
        />
        <TextArea
          name="parkingNotes"
          label="Parking notes"
          errors={state.errors}
          defaultValue={was?.["parkingNotes"]}
        />
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton>Add property</SubmitButton>
        {state.message && !state.errors ? (
          <span className="text-sm text-good">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
