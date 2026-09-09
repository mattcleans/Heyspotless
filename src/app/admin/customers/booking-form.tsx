"use client";

import { useActionState, useState } from "react";
import { Field, FormError, Select, SubmitButton, TextArea } from "@/components/form";
import type { Property } from "@/lib/data/types";
import {
  FREQUENCY_LABELS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  frequenciesForService,
  type ServiceType,
} from "@/lib/pricing/price-book";
import { bookJob, type FormState } from "./actions";

/**
 * Booking a clean.
 *
 * The frequency options narrow to what the chosen service is actually sold at —
 * Deep is one-time/monthly, Move In/Out is one-time only — using the same
 * `frequenciesForService` the quote builder and the server-side validation use.
 * Offering an unsellable pair and then rejecting it would be a worse form than
 * one that never offers it.
 *
 * There is no price field. The total is computed server-side from the price book
 * and the property's stored rooms, so it cannot be set from here.
 */
export function BookingForm({
  customerId,
  properties,
}: {
  customerId: string;
  properties: readonly Property[];
}) {
  const action = bookJob.bind(null, customerId);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [service, setService] = useState<ServiceType>("standard");

  const frequencies = frequenciesForService(service);

  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state.message} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          name="propertyId"
          label="Property"
          errors={state.errors}
          options={properties.map((p) => ({ value: p.id, label: `${p.street}, ${p.city}` }))}
        />
        <Field
          name="scheduledStart"
          label="Date and time"
          type="datetime-local"
          hint="Leave empty to put it on the board unscheduled."
          errors={state.errors}
          defaultValue={state.values?.["scheduledStart"]}
        />
        <Select
          name="service"
          label="Service"
          value={service}
          onChange={(v) => setService(v as ServiceType)}
          errors={state.errors}
          options={SERVICE_TYPES.map((s) => ({ value: s, label: SERVICE_LABELS[s] }))}
        />
        <Select
          name="frequency"
          label="Frequency"
          errors={state.errors}
          hint="Only what this service is sold at."
          options={frequencies.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] }))}
        />
      </div>

      <TextArea
        name="notes"
        label="Notes"
        errors={state.errors}
        defaultValue={state.values?.["notes"]}
      />

      <div className="flex items-center gap-3">
        <SubmitButton>Book clean</SubmitButton>
        {state.message && !state.errors ? (
          <span className="text-sm text-good">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
