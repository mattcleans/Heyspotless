import { PageHeader, Callout } from "@/components/ui";
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  PRICE_BOOK_EXTRAS,
  SERVICE_LABELS,
  SERVICE_TYPES,
  frequenciesForService,
  itemsForService,
} from "@/lib/pricing/price-book";
import { formatCents, formatHours } from "@/lib/money";

export const metadata = { title: "Price book — Spotless Ops" };

export default function PriceBookPage() {
  return (
    <>
      <PageHeader eyebrow="Admin" title="Price book">
        The Hey Spotless pricelist effective 9 August 2026, as structured data. This is the single
        source of truth for quoting — and its totals are asserted against the published quote table
        in both the TypeScript and SQL test suites.
      </PageHeader>

      <Callout tone="warn" label="Recurring rates already include the discount">
        The monthly, bi-weekly and weekly columns are the discounted rates, not a multiplier applied
        to the one-time price. Applying a further discount would double it. A multiplier could not
        reproduce them anyway: Standard Bedroom drops $20 → $17 bi-weekly (0.85) while Half Bath
        drops $11 → $10 (0.91), because whole-dollar rounding had nowhere else to land.
      </Callout>

      {SERVICE_TYPES.map((service) => {
        const items = itemsForService(service);
        const freqs = frequenciesForService(service);
        return (
          <section key={service} className="mt-8">
            <h2 className="mb-1 text-lg font-semibold text-navy">{SERVICE_LABELS[service]}</h2>
            <p className="mb-3 text-xs text-ink-3">
              Sold {freqs.map((f) => FREQUENCY_LABELS[f].toLowerCase()).join(", ")}.
            </p>
            <div className="card overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2">
                    <th className="px-4 py-2.5 font-mono text-[10px] font-semibold tracking-wider text-ink-2 uppercase">
                      Item
                    </th>
                    {FREQUENCIES.map((f) => (
                      <th
                        key={f}
                        className="px-4 py-2.5 text-right font-mono text-[10px] font-semibold tracking-wider text-ink-2 uppercase"
                      >
                        {FREQUENCY_LABELS[f]}
                      </th>
                    ))}
                    <th className="px-4 py-2.5 text-right font-mono text-[10px] font-semibold tracking-wider text-ink-2 uppercase">
                      Est. time
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.itemKey} className="border-b border-line-soft last:border-0">
                      <td className="px-4 py-2 text-ink">{item.name}</td>
                      {FREQUENCIES.map((f) => (
                        <td key={f} className="nums px-4 py-2 text-right">
                          {item.rates[f] !== undefined ? (
                            formatCents(item.rates[f]!)
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                      ))}
                      <td className="nums px-4 py-2 text-right text-ink-3">
                        {formatHours(item.cleanMinutes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section className="mt-8">
        <h2 className="mb-1 text-lg font-semibold text-navy">Extras</h2>
        <p className="mb-3 text-xs text-ink-3">
          Flat, never discounted, and not part of the August 2026 increase.
        </p>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {PRICE_BOOK_EXTRAS.map((x) => (
                <tr key={x.itemKey} className="border-b border-line-soft last:border-0">
                  <td className="px-4 py-2 text-ink">{x.name}</td>
                  <td className="nums px-4 py-2 text-right">{formatCents(x.priceCents)}</td>
                  <td className="px-4 py-2 text-xs text-ink-3">{x.unitLabel}</td>
                  <td className="nums px-4 py-2 text-right text-ink-3">
                    {formatHours(x.cleanMinutes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-6 text-xs text-ink-3">
        Estimated times are estimates, not measurements — chosen so a 2bd/2ba standard lands at 2.3h
        and a 3bd/2ba at 2.55h. The app recalibrates them from clocked time as jobs complete, which
        matters because payout is computed from estimated hours.
      </p>
    </>
  );
}
