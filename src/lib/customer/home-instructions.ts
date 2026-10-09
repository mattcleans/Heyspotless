import type { Property } from "@/lib/data/types";

export const INSTRUCTION_LIMITS = { gateCode: 200, accessNotes: 1000, parkingNotes: 1000, pets: 1000 } as const;
export const INSTRUCTION_LABELS = { gateCode: "Gate code", accessNotes: "Getting in", parkingNotes: "Parking", pets: "Pets" } as const;
export type InstructionField = keyof typeof INSTRUCTION_LIMITS;
export const INSTRUCTION_FIELDS = Object.keys(INSTRUCTION_LIMITS) as InstructionField[];
export type HomeInstructions = Record<InstructionField, string | null>;
export const isStoredHomeId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Preserve the original values exactly for conflict detection. */
export function instructionsFor(property: Property): HomeInstructions {
  return { gateCode: property.gateCode, accessNotes: property.accessNotes, parkingNotes: property.parkingNotes, pets: property.pets };
}
export function parseHomeInstructions(raw: unknown, normalize = true): HomeInstructions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Check your home instructions and try again.");
  const input = raw as Record<string, unknown>;
  const values = {} as HomeInstructions;
  for (const field of INSTRUCTION_FIELDS) {
    const value = input[field];
    if (value !== null && typeof value !== "string") throw new Error(`Check ${INSTRUCTION_LABELS[field].toLowerCase()} and try again.`);
    const text = typeof value === "string" ? normalize ? value.trim() : value : null;
    if (normalize && text && text.length > INSTRUCTION_LIMITS[field]) throw new Error(`${INSTRUCTION_LABELS[field]} must be ${INSTRUCTION_LIMITS[field]} characters or fewer.`);
    values[field] = normalize && text === "" ? null : text;
  }
  return values;
}
