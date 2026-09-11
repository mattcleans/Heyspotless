"use client";

import { useActionState, useState } from "react";
import { Checkbox, Field, FormError, Select, SubmitButton, TextArea } from "@/components/form";
import type { Property } from "@/lib/data/types";
import {
  FREQUENCY_LABELS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  frequenciesForService,
  type Frequency,
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
 * FREQUENCY AND REPEATING ARE TWO DIFFERENT CHOICES, and the form keeps them
 * apart because they used to be conflated. The frequency sets the RATE — a
 * fortnightly clean is priced fortnightly whether or not it repeats, because
 * somebody booking a single visit at the fortnightly rate is a real thing.
 * "Repeat this automatically" is what creates a standing plan.
 *
 * Ticking it starts a commitment against a customer's card, so the form says
 * what will happen in full — how often, from when, at what rate — rather than
 * leaving an operator to infer it from a checkbox.
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
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [repeats, setRepeats] = useState(false);

  const frequencies = frequenciesForService(service);
  // Changing the service can make the chosen frequency unsellable — Deep is
  // one-time or monthly only. Fall back to what this service actually offers
  // rather than posting a pair the price book will refuse.
  const effectiveFrequency = frequencies.includes(frequency) ? frequency : frequencies[0]!;
  const canRepeat = effectiveFrequency !== "one_time";

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
          hint={
            repeats
              ? "The first visit. The whole schedule follows from it."
              : "Leave empty to put it on the board unscheduled."
          }
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
          value={effectiveFrequency}
          onChange={(v) => setFrequency(v as Frequency)}
          errors={state.errors}
          hint="Sets the rate. Repeating is the separate choice below."
          options={frequencies.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] }))}
        />
      </div>

      {canRepeat ? (
        <div className="rounded-lg border border-line-soft bg-surface-2 px-3 py-2.5">
          <Checkbox
            name="repeats"
            label="Repeat this automatically"
            checked={repeats}
            onChange={setRepeats}
            errors={state.errors}
            hint={
              repeats
                ? `Starts a standing ${FREQUENCY_LABELS[frequency].toLowerCase()} plan from the ` +
                  `date above, at today's rate. Later price changes will not move it. ` +
                  `Visits appear on the board about six weeks ahead, and any one can be ` +
                  `skipped without touching the rest.`
                : `Books a single visit, priced at the ` +
                  `${FREQUENCY_LABELS[frequency].toLowerCase()} rate. Nothing follows it.`
            }
          />
        </div>
      ) : (
        <p className="rounded-lg border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-3">
          {SERVICE_LABELS[service]} is sold one-time only, so this books a single visit.
        </p>
      )}

      <TextArea
        name="notes"
        label="Notes"
        errors={state.errors}
        defaultValue={state.values?.["notes"]}
      />

      <div className="flex items-center gap-3">
        <SubmitButton>{repeats ? "Start plan" : "Book clean"}</SubmitButton>
        {state.message && !state.errors ? (
          <span className="text-sm text-good">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
