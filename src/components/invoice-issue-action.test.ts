import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect,vi} from "vitest";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
import {InvoiceIssueAction} from "./invoice-issue-action";
describe("invoice review",()=>{
 it("shows the exact bill/amount/date and requires review before issuance",()=>{const html=renderToStaticMarkup(createElement(InvoiceIssueAction,{visitId:"11111111-1111-4111-8111-111111111111",invoiceId:"22222222-2222-4222-8222-222222222222",totalCents:19900,defaultDueOn:"2026-11-01"}));expect(html).toContain("$199.00");expect(html).toContain("22222222-2222-4222-8222-222222222222");expect(html).toContain('type="date"');expect(html).toContain("2026-11-01");expect(html).toMatch(/button[^>]*disabled/);expect(html).toContain("No automatic payment, email or text is triggered.");expect(html).toContain("min-h-11");});
});
