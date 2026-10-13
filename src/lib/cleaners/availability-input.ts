export interface AvailabilityWindow {
  day: number;
  startsAt: string;
  endsAt: string;
}

export function parseAvailability(value: unknown): AvailabilityWindow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 28) {
    throw new Error("Add at least one working window. For time away from work, contact the office.");
  }
  const windows = value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Check each working window.");
    const row = item as Record<string, unknown>;
    if (typeof row.day !== "number" || !Number.isInteger(row.day) || row.day < 0 || row.day > 6) {
      throw new Error("Choose a valid weekday for each window.");
    }
    if (typeof row.startsAt !== "string" || typeof row.endsAt !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.startsAt) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.endsAt) ||
      row.endsAt <= row.startsAt) {
      throw new Error("End times must be later than start times on the same day.");
    }
    return { day: row.day, startsAt: row.startsAt, endsAt: row.endsAt };
  }).sort((a, b) => a.day - b.day || a.startsAt.localeCompare(b.startsAt));
  for (let i = 1; i < windows.length; i++) {
    const current = windows[i]!;
    const previous = windows[i - 1]!;
    if (current.day === previous.day && current.startsAt < previous.endsAt) {
      throw new Error("Working windows on the same day must not overlap.");
    }
  }
  return windows;
}
