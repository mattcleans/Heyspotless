import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { QuoteBuilder } from "./quote-builder";

export const metadata = { title: "Quote builder | Hey Spotless management" };

export default function QuotePage() {
  return (
    <>
      <PageHeader eyebrow="Admin" title="Quote builder">
        One path from room counts to a price. The booking widget, this builder,
        and recurring plan generation all call the same function, so a quote
        cannot differ depending on where it was made — which is exactly how the
        Housecall Pro Services book and pricing forms drifted apart.
      </PageHeader>
      <p className="mb-5 text-sm">
        To publish a quote for a saved home,{" "}
        <Link href="/admin/customers" className="underline">
          open the client and choose Prepare and review quotes
        </Link>
        .
      </p>
      <QuoteBuilder />
    </>
  );
}
