import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { HomeSetupForm } from "./home-setup-form";
import { SignupForm } from "@/app/signup/signup-form";
import { BookingForm } from "@/app/customer/book/booking-form";
describe("first-home entry screens", () => {
  it("asks new Clients for contact details and each priced room count", () => {
    const h = renderToStaticMarkup(createElement(HomeSetupForm, { needsContact: true, demo: false }));
    for (const label of ["First name", "Last name", "Phone for your visit", "Street address", "Full bathrooms", "Half bathrooms", "Utility rooms", "Review home"]) expect(h).toContain(label);
    expect(h).not.toContain("customerId"); expect(h).not.toContain("gate_code");
  });
  it("never asks returning Clients to rewrite saved contact details", () => {
    const h = renderToStaticMarkup(createElement(HomeSetupForm, { needsContact: false, demo: false })); expect(h).not.toContain("First name"); expect(h).not.toContain("Phone for your visit");
  });
  it("keeps password signup primary and does not offer a staff role", () => {
    const h = renderToStaticMarkup(createElement(SignupForm, { demo: false }));
    expect(h.match(/autoComplete="new-password"/g)).toHaveLength(2); expect(h).toContain("Create Client account"); expect(h).not.toContain('<select');
  });
  it("selects the newly saved owned home even when another home sorts first", () => {
    const home = { id: "old", street: "Old home", city: "Dallas", state: "TX", zip: "75201", rooms: { bedrooms: 2, bathrooms: 2 } };
    const h = renderToStaticMarkup(createElement(BookingForm, { homes: [home, { ...home, id: "new", street: "New home" }], initialHome: "new", reviews: [] }));
    expect(h).toContain('<option value="new" selected="">');
  });
});
