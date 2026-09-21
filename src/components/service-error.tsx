"use client";
export function ServiceError({ reset }: { reset: () => void }) {
  return (
    <section className="visit-feature" role="alert">
      <h1 className="text-xl font-semibold text-navy">
        We couldn’t load this right now.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">
        Try again to get the latest details. If a visit is coming up or you need
        help, call Hey Spotless at{" "}
        <a href="tel:+14692800397" className="underline">
          469-280-0397
        </a>
        .
      </p>
      <button onClick={reset} className="primary-action mt-5">
        Try again
      </button>
    </section>
  );
}
