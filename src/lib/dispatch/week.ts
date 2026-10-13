import { addCalendarDays, dayOfWeek, todayIn, type CalendarDate } from "../time/zone";

/** Monday containing this instant in Dallas, independent of the process zone. */
export function matchingWeek(on: Date): CalendarDate {
  const day = todayIn(undefined, on);
  return addCalendarDays(day, -((dayOfWeek(day) + 6) % 7));
}
