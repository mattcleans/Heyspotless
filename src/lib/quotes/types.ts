import {
  SERVICE_TYPES,
  FREQUENCIES,
  type ServiceType,
  type Frequency,
} from "@/lib/pricing/price-book";
import { zonedTimeToUtc } from "@/lib/time/zone";
export type QuoteState =
  | "review"
  | "published"
  | "accepted"
  | "declined"
  | "expired"
  | "stale"
  | "withdrawn"
  | "booked";
export type ClientQuote = {
  id: string;
  customerId: string;
  propertyId: string;
  service: ServiceType;
  frequency: Frequency;
  totalCents: number;
  estimatedMinutes: number;
  proposedStart: string;
  expiresAt: string;
  repeats: boolean;
  note: string;
  version: number;
  accepted: boolean | null;
  decisionId: string | null;
  jobId: string | null;
  planId: string | null;
  state: QuoteState;
  home: { street: string; city: string; state: string; zip: string };
  lines: {
    itemKey: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    cleanMinutes: number;
    isExtra: boolean;
  }[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function quoteId(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new Error("Invalid ID");
  return v.toLowerCase();
}
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid quote");
  return v as Record<string, unknown>;
}
function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("Invalid text");
  return v;
}
function int(v: unknown, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    throw new Error("Invalid number");
  return v;
}
function time(v: unknown) {
  const s = str(v);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s,
    ) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new Error("Invalid time");
  return s;
}
function nullableId(v: unknown) {
  return v === null ? null : quoteId(v);
}
export function toPricedTerms(v: unknown): Pick<ClientQuote, "lines" | "totalCents" | "estimatedMinutes"> {
  const q = obj(v);
  if (!Array.isArray(q.lines) || q.lines.length === 0) throw new Error("Invalid lines");
  const lines = q.lines.map((v) => {
    const l = obj(v);
    if (typeof l.isExtra !== "boolean") throw new Error("Invalid line");
    const line = {
      itemKey: str(l.itemKey),
      name: str(l.name),
      quantity: int(l.quantity, 1),
      unitPriceCents: int(l.unitPriceCents),
      totalCents: int(l.totalCents),
      cleanMinutes: int(l.cleanMinutes),
      isExtra: l.isExtra,
    };
    if (line.quantity * line.unitPriceCents !== line.totalCents)
      throw new Error("Invalid line total");
    return line;
  });
  const totalCents = int(q.totalCents, 1),
    estimatedMinutes = int(q.estimatedMinutes, 1);
  if (
    lines.reduce((s, l) => s + l.totalCents, 0) !== totalCents ||
    lines.reduce((s, l) => s + l.cleanMinutes, 0) !== estimatedMinutes
  )
    throw new Error("Invalid totals");
  return { lines, totalCents, estimatedMinutes };
}
export function toClientQuote(v: unknown): ClientQuote {
  const q = obj(v),
    home = obj(q.home);
  if (
    !SERVICE_TYPES.includes(q.service as ServiceType) ||
    !FREQUENCIES.includes(q.frequency as Frequency) ||
    ![
      "review",
      "published",
      "accepted",
      "declined",
      "expired",
      "stale",
      "withdrawn",
      "booked",
    ].includes(str(q.state)) ||
    typeof q.repeats !== "boolean" ||
    (q.accepted !== null && typeof q.accepted !== "boolean") ||
    !Array.isArray(q.lines) ||
    q.lines.length === 0
  )
    throw new Error("Invalid terms");
  const { lines, totalCents, estimatedMinutes } = toPricedTerms(q);
  if (q.repeats && q.frequency === "one_time")
    throw new Error("Invalid recurrence");
  const state = q.state as QuoteState,
    accepted = q.accepted as boolean | null,
    decisionId = nullableId(q.decisionId),
    jobId = nullableId(q.jobId),
    planId = nullableId(q.planId);
  if (
    (state === "accepted" && accepted !== true) ||
    (state === "declined" && accepted !== false) ||
    (accepted !== null && !decisionId) ||
    (planId && !q.repeats)
  )
    throw new Error("Invalid decision");
  return {
    id: quoteId(q.id),
    customerId: quoteId(q.customerId),
    propertyId: quoteId(q.propertyId),
    service: q.service as ServiceType,
    frequency: q.frequency as Frequency,
    totalCents,
    estimatedMinutes,
    lines,
    proposedStart: time(q.proposedStart),
    expiresAt: time(q.expiresAt),
    repeats: q.repeats,
    note: str(q.note),
    version: int(q.version),
    accepted,
    decisionId,
    jobId,
    planId,
    state,
    home: {
      street: str(home.street),
      city: str(home.city),
      state: str(home.state),
      zip: str(home.zip),
    },
  };
}
export type QuoteAction =
  | {
      action: "prepare";
      id: string;
      propertyId: string;
      service: ServiceType;
      frequency: Frequency;
      start: string;
      expires: string;
      repeats: boolean;
      extras: { itemKey: string; quantity: number }[];
      note: string;
    }
  | { action: "publish" | "withdraw"; id: string }
  | { action: "book"; id: string; version: number }
  | {
      action: "decide";
      id: string;
      requestId: string;
      version: number;
      accept: boolean;
    };
export function parseQuoteAction(v: unknown): QuoteAction {
  const b = obj(v),
    id = quoteId(b.id),
    action = b.action;
  const keys =
    action === "prepare"
      ? [
          "action",
          "id",
          "propertyId",
          "service",
          "frequency",
          "start",
          "expires",
          "repeats",
          "extras",
          "note",
        ]
      : action === "decide"
        ? ["action", "id", "requestId", "version", "accept"]
        : action === "book"
          ? ["action", "id", "version"]
          : ["action", "id"];
  if (Object.keys(b).sort().join(",") !== keys.sort().join(","))
    throw new Error("Unexpected fields");
  if (action === "publish" || action === "withdraw") return { action, id };
  if (action === "book") return { action, id, version: int(b.version) };
  if (action === "decide") {
    if (typeof b.accept !== "boolean") throw new Error("Decision required");
    return {
      action,
      id,
      version: int(b.version),
      requestId: quoteId(b.requestId),
      accept: b.accept,
    };
  }
  if (
    action !== "prepare" ||
    !SERVICE_TYPES.includes(b.service as ServiceType) ||
    !FREQUENCIES.includes(b.frequency as Frequency) ||
    typeof b.repeats !== "boolean" ||
    !Array.isArray(b.extras) ||
    b.extras.length > 30 ||
    str(b.note).length > 1500
  )
    throw new Error("Check terms");
  const start = zonedTimeToUtc(str(b.start)),
    expires = zonedTimeToUtc(str(b.expires));
  if (!start.ok || !expires.ok) throw new Error("Choose a valid Dallas time");
  const seen = new Set<string>();
  const extras = b.extras.map((v) => {
    const e = obj(v),
      itemKey = str(e.itemKey),
      quantity = int(e.quantity, 1);
    if (
      Object.keys(e).sort().join(",") !== "itemKey,quantity" ||
      !itemKey ||
      itemKey.length > 80 ||
      quantity > 20 ||
      seen.has(itemKey)
    )
      throw new Error("Check extras");
    seen.add(itemKey);
    return { itemKey, quantity };
  });
  return {
    action,
    id,
    propertyId: quoteId(b.propertyId),
    service: b.service as ServiceType,
    frequency: b.frequency as Frequency,
    start: start.date.toISOString(),
    expires: expires.date.toISOString(),
    repeats: b.repeats,
    extras,
    note: str(b.note).trim(),
  };
}
export const QUOTE_LABELS: Record<QuoteState, string> = {
  review: "Office review",
  published: "Your decision needed",
  accepted: "Accepted · office scheduling",
  declined: "Declined",
  expired: "Expired",
  stale: "New quote needed",
  withdrawn: "Withdrawn",
  booked: "Booked",
};

export function quoteCadence(
  q: Pick<ClientQuote, "proposedStart" | "frequency" | "repeats">,
): string {
  if (!q.repeats) return "One visit; no recurring schedule will be created.";
  const instant = new Date(q.proposedStart),
    zone = "America/Chicago";
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
  if (q.frequency === "weekly")
    return `Every ${weekday} at ${time}, Dallas time.`;
  if (q.frequency === "biweekly")
    return `Every other ${weekday} at ${time}, Dallas time.`;
  const day = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, day: "numeric" }).format(
      instant,
    ),
  );
  const ordinal = ["first", "second", "third", "fourth", "fifth"][
    Math.floor((day - 1) / 7)
  ];
  return `Every month on the ${ordinal} ${weekday}${ordinal === "fifth" ? ` (or the last ${weekday} in a shorter month)` : ""} at ${time}, Dallas time.`;
}
