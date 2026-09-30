export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <section role="status" aria-live="polite" aria-busy="true" className="visit-feature">
      <h1 className="text-xl font-semibold text-navy">{label}</h1>
      <p className="mt-3 text-sm text-ink-2">Getting the latest details.</p>
      <div aria-hidden="true" className="mt-5 space-y-3">
        <div className="h-4 w-2/3 rounded bg-surface-2" />
        <div className="h-4 w-1/2 rounded bg-surface-2" />
      </div>
    </section>
  );
}
