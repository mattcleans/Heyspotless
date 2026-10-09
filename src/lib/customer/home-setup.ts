export const HOME_FIELDS = ["street", "city", "state", "zip", "bedrooms", "bathrooms", "halfBaths", "kitchens", "livingRooms", "utilityRooms"] as const;
export const ROOM_FIELDS = ["bedrooms", "bathrooms", "halfBaths", "kitchens", "livingRooms", "utilityRooms"] as const;
export const ROOM_LABELS: Record<typeof ROOM_FIELDS[number], string> = { bedrooms: "Bedrooms", bathrooms: "Full bathrooms", halfBaths: "Half bathrooms", kitchens: "Kitchens", livingRooms: "Living rooms", utilityRooms: "Utility rooms" };
export type HomeInput = { street: string; city: string; state: string; zip: string; bedrooms: number; bathrooms: number; halfBaths: number; kitchens: number; livingRooms: number; utilityRooms: number };
export type ContactInput = { firstName: string; lastName: string; phone: string };
export type HomeSetup = { id: string; home: HomeInput; contact: ContactInput | null };
export type SavedHome = { id: string; customerId: string; home: HomeInput };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your home details.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(k => !(k in value))) throw new Error("Check your home details.");
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Check your address and contact details.");
  return value.trim();
}
function homeInput(value: unknown): HomeInput {
  const h = object(value); exact(h, HOME_FIELDS);
  const home = { street: text(h.street, 200), city: text(h.city, 100), state: text(h.state, 2).toUpperCase(), zip: text(h.zip, 5) } as HomeInput;
  if (!/^[A-Z]{2}$/.test(home.state) || !/^\d{5}$/.test(home.zip)) throw new Error("Use a two-letter state and five-digit ZIP code.");
  for (const key of ROOM_FIELDS) {
    const n = h[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > (key === "halfBaths" ? 4 : 8)) throw new Error("Check the number of rooms.");
    home[key] = n;
  }
  return home;
}
export function parseHomeSetup(value: unknown): HomeSetup {
  const v = object(value); exact(v, ["id", "home", "contact"]);
  if (typeof v.id !== "string" || !uuid.test(v.id)) throw new Error("Review your home again.");
  let contact: ContactInput | null = null;
  if (v.contact !== null) {
    const c = object(v.contact); exact(c, ["firstName", "lastName", "phone"]);
    contact = { firstName: text(c.firstName, 80), lastName: text(c.lastName, 80), phone: text(c.phone, 32) };
    if (!/^[+()\d .-]{7,32}$/.test(contact.phone) || (contact.phone.match(/\d/g)?.length ?? 0) < 7) throw new Error("Enter a phone number we can use for your visit.");
  }
  return { id: v.id, home: homeInput(v.home), contact };
}
export function savedHome(value: unknown, requested: HomeSetup): SavedHome {
  const v = object(value);
  if (typeof v.id !== "string" || !uuid.test(v.id) || typeof v.customerId !== "string" || !uuid.test(v.customerId)) throw new Error("Save result unavailable.");
  const home = homeInput(v.home);
  if (HOME_FIELDS.some(k => home[k] !== requested.home[k])) throw new Error("Save result unavailable.");
  return { id: v.id, customerId: v.customerId, home };
}
