export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <section className="visit-feature">
      <div role="status" aria-live="polite" aria-busy="true">
        <h1 className="text-xl font-semibold text-navy">{label}</h1>
        <p className="mt-3 text-sm text-ink-2">Getting the latest details.</p>
        <div aria-hidden="true" className="mt-5 space-y-3">
          <div className="h-4 w-2/3 rounded bg-surface-2" />
          <div className="h-4 w-1/2 rounded bg-surface-2" />
        </div>
      </div>
      <p className="mt-5 max-w-prose text-sm leading-relaxed text-ink-2">
        If this page stays here, reload it to try again. For help with an upcoming
        visit, call the office.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {/* A document link also works before the app has hydrated. */}
        <a href="" className="secondary-action">
          Reload page
        </a>
        <a href="tel:+14692800397" className="secondary-action">
          Call the office
        </a>
      </div>
    </section>
  );
}
