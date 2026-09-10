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
 *
 * WHAT FREQUENCY DOES, AND DOES NOT, DO. It books ONE clean, at the recurring
 * rate. It does not create a schedule: choosing "Weekly" does not put next
 * week's visit on the board, and nothing here will. Recurring plans —
 * generating the series, skipping a week, changing the day, holding a rate
 * across a price change — are not built. The form says so, because an
 * operator who ticks Weekly and assumes the rest is handled will find out in
 * a fortnight when a customer rings to ask where the cleaner is.
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
          hint="Sets the rate for this one clean. It does not schedule a series."
          options={frequencies.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] }))}
        />
      </div>

      {/*
        Stated on the form rather than only in the docs. The dropdown reads
        exactly like the one in a tool that does create the series, and the
        cost of the wrong assumption is a customer waiting for a cleaner who
        was never booked.
      */}
      <p className="rounded-lg border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-3">
        <strong className="font-semibold text-ink-2">One clean per booking.</strong> A
        recurring frequency prices this visit at the recurring rate; it does not create
        the following visits. Book each one, or keep the series in Housecall Pro until
        recurring plans are built.
      </p>

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
