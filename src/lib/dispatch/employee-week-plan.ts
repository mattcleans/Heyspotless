import { matchingWeek } from "./week";
import { residualGuaranteedHours, scheduledHoursInWeek, type BoardEntry, type DispatchContext } from "./engine";
import { forecastWeek } from "./route";

/** Forecast each employee separately in each represented Dallas week. */
export function employeeWeekPlan(entries: readonly BoardEntry[], context: DispatchContext, averageTicketCents: number) {
  const weeks = [...new Set([matchingWeek(context.now), ...entries
    .filter(e => e.decision.kind !== "needs_scheduling" && e.job.scheduledStart)
    .map(e => matchingWeek(e.job.scheduledStart!))])].sort();
  return weeks.map(week => ({
    week,
    employees: context.cleaners.filter(c => c.type === "w2_core" && c.terms).map(cleaner => {
      const priorHours = scheduledHoursInWeek(cleaner, week, context);
      const proposed = entries.filter(e => e.job.scheduledStart && matchingWeek(e.job.scheduledStart) === week
        && (e.decision.kind === "assign_guaranteed" || e.decision.kind === "assign_w2")
        && e.decision.cleaner.id === cleaner.id);
      return {
        cleaner, priorHours, proposedVisits: proposed.length,
        guaranteeLeft: residualGuaranteedHours(entries, context, week).get(cleaner.id) ?? 0,
        forecast: forecastWeek(cleaner, proposed.map(({ job }) => ({
          cleanMinutes: job.estimatedCleanMinutes, driveMinutes: context.driveFor(cleaner, job).minutes,
        })), averageTicketCents, priorHours * 60),
      };
    }),
  }));
}
