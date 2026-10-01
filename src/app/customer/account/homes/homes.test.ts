import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({ repo: vi.fn(), customer: vi.fn(), properties: vi.fn(), property: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: mocks.repo }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, useRouter: () => ({ refresh: vi.fn() }) }));
import HomesPage from "./page";
import HomeInstructionsPage from "./[id]/page";
const id = "95000000-0000-0000-0000-000000000001";
const home = { id, customerId: "my-customer", street: "Test home", city: "Dallas", state: "TX", zip: "75024", gateCode: "1234", accessNotes: "Front door", parkingNotes: null, pets: "Cat" };
function account(role: string | null, demo = false) {
  mocks.repo.mockResolvedValue({ isDemo: demo, getCurrentProfile: async () => role ? { id: "self", role } : null, getCustomerByProfile: mocks.customer, listProperties: mocks.properties, getProperty: mocks.property });
}
const detail = (homeId = id) => HomeInstructionsPage({ params: Promise.resolve({ id: homeId }) });
beforeEach(() => {
  vi.clearAllMocks(); account("customer");
  mocks.customer.mockResolvedValue({ id: "my-customer" }); mocks.properties.mockResolvedValue([home]); mocks.property.mockResolvedValue(home);
});
describe("home instruction screens", () => {
  it.each([null, "admin", "cleaner"])("does not load home data for role %s", async role => {
    account(role);
    expect(renderToStaticMarkup(await HomesPage())).toContain("Connect your account");
    expect(renderToStaticMarkup(await detail())).toContain("Sign in with your client account");
    expect(mocks.customer).not.toHaveBeenCalled(); expect(mocks.properties).not.toHaveBeenCalled(); expect(mocks.property).not.toHaveBeenCalled();
  });
  it("reads only the linked customer's homes and does not reveal gate codes in the list", async () => {
    const html = renderToStaticMarkup(await HomesPage());
    expect(mocks.customer).toHaveBeenCalledWith("self"); expect(mocks.properties).toHaveBeenCalledWith("my-customer");
    expect(html).toContain(`/customer/account/homes/${id}`); expect(html).not.toContain("1234");
  });
  it("returns not-found for another client's home", async () => {
    mocks.property.mockResolvedValue({ ...home, customerId: "other" });
    await expect(detail()).rejects.toThrow("not-found");
  });
  it("returns not-found for a malformed stored id without a data read", async () => {
    await expect(detail("not-an-id")).rejects.toThrow("not-found"); expect(mocks.property).not.toHaveBeenCalled();
  });
  it("an unlinked account never requests an unscoped property list", async () => {
    mocks.customer.mockResolvedValue(null);
    await HomesPage(); await detail();
    expect(mocks.properties).not.toHaveBeenCalled(); expect(mocks.property).not.toHaveBeenCalled();
  });
  it("shows a genuine no-homes state with office and booking recovery", async () => {
    mocks.properties.mockResolvedValue([]);
    const html = renderToStaticMarkup(await HomesPage());
    expect(html).toContain("No homes connected yet"); expect(html).toContain("request a clean"); expect(html).toContain("tel:+14692800397");
  });
  it("renders own instructions with a masked gate field and correct bounds", async () => {
    const html = renderToStaticMarkup(await detail());
    expect(html).toContain('type="password"'); expect(html).toContain('maxLength="200"'); expect(html).toContain('maxLength="1000"');
    expect(html).toContain("Front door"); expect(html).toContain("Save home instructions");
  });
  it("supports demo property ids but disables saving sample instructions", async () => {
    account(null, true); mocks.property.mockResolvedValue({ ...home, id: "sample-home" });
    const html = renderToStaticMarkup(await detail("sample-home"));
    expect(html).toContain("sample home instructions"); expect(html).toContain('type="submit" disabled=""');
  });
});
