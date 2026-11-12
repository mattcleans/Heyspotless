import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CUSTOMER_BRAND } from "../brand";
import { toTransition, type StripeEventLike } from "./events";
import { listChargeRefunds, lookUpPaymentIntent } from "./gateway";

/**
 * The gate nothing else closes: real Stripe objects, real Postgres.
 *
 * Every other billing test proves the code agrees with itself. The event
 * mapping is asserted against payloads I wrote; the SQL is asserted against
 * rows I inserted. Both can be perfectly self-consistent and still wrong
 * about what Stripe actually sends — a field that is a string when I assumed
 * an object, an amount reported somewhere else, an error shaped differently
 * from the one `isDecline` looks for. That assumption is only testable
 * against Stripe.
 *
 * So this drives Stripe TEST MODE for real, takes the events Stripe itself
 * generates, and runs them through the real mapping into the real SQL.
 *
 * SKIPPED unless both are set, so `npm test` is unaffected:
 *
 *   STRIPE_SECRET_KEY     a test-mode key (sk_test_…). Refuses a live key.
 *   SPOTLESS_VERIFY_DB    a database with every migration applied —
 *                         ./scripts/verify-migrations.sh leaves one behind.
 *   PGHOST               optional absolute path to a local PostgreSQL socket.
 *                         Uses the current OS user and libpq environment.
 *
 *   STRIPE_SECRET_KEY=sk_test_… SPOTLESS_VERIFY_DB=spotless_verify \
 *     npx vitest run src/lib/billing/stripe-live.test.ts
 *
 * It creates nothing outside test mode and takes no real money. The key
 * guard below is the only thing standing between this and someone's live
 * account, so it fails hard rather than warning.
 */

const KEY = process.env["STRIPE_SECRET_KEY"] ?? "";
const DB = process.env["SPOTLESS_VERIFY_DB"] ?? "";
const CONFIGURED = KEY !== "" && DB !== "";

if (KEY !== "" && !KEY.startsWith("sk_test_")) {
  throw new Error(
    "stripe-live.test.ts refuses to run against a key that is not sk_test_. " +
      "This test creates charges and refunds; against a live key that is real money.",
  );
}

const socket = process.env.PGHOST;

if (
  CONFIGURED &&
  (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(DB) ||
    (socket && (!socket.startsWith("/") || socket.includes(","))) ||
    process.env.PGHOSTADDR ||
    process.env.PGSERVICE)
) {
  throw new Error("Use a disposable database name and a local PostgreSQL socket.");
}

/** One psql round trip. Shelling out keeps this dependency-free, as verify-migrations.sh is. */
function sql(statement: string): string {
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "-tAqc", statement, "-d", DB];
  if (socket) {
    return execFileSync("psql", ["-h", socket, ...args], { encoding: "utf8" }).trim();
  }
  return execFileSync("sudo", ["-u", "postgres", "psql", ...args], {
    encoding: "utf8",
  }).trim();
}

/** The most recent event of a type, as Stripe itself emitted it. */
async function latestEvent(stripe: Stripe, type: string, matches: (o: Record<string, unknown>) => boolean) {
  return vi.waitFor(async () => {
    const events = await stripe.events.list({ type, limit: 20 });
    const found = events.data.find((e) => matches(e.data.object as unknown as Record<string, unknown>));
    if (!found) throw new Error(`no ${type} event found for the object just created`);
    return found as unknown as StripeEventLike;
  }, { timeout: 20_000, interval: 500 });
}

describe.skipIf(!CONFIGURED)("against Stripe test mode and real Postgres", () => {
  let stripe: Stripe;
  let customerId: string;
  let invoiceId: string;

  beforeAll(async () => {
    stripe = new Stripe(KEY);

    // A customer and an unpaid $170 invoice, in our own database.
    customerId = sql(
      `insert into customers (first_name, last_name) values ('Stripe','Live') returning id`,
    );
    invoiceId = sql(
      `insert into invoices (customer_id, status, subtotal_cents, total_cents)
       values ('${customerId}', 'sent', 17000, 17000) returning id`,
    );
  }, 60_000);

  /**
   * The bug that broke twice. Two cards on file, Stripe redelivers the
   * DEFAULT card's attach event, and the default must survive.
   */
  it("keeps the default card default when Stripe redelivers its attach event", async () => {
    const stripeCustomer = await stripe.customers.create({ name: "Stripe Live" });
    sql(
      `update customers set stripe_customer_id = '${stripeCustomer.id}' where id = '${customerId}'`,
    );

    const cardA = await stripe.paymentMethods.attach("pm_card_visa", {
      customer: stripeCustomer.id,
    });
    const cardB = await stripe.paymentMethods.attach("pm_card_mastercard", {
      customer: stripeCustomer.id,
    });

    // Stripe's own event, not one I wrote.
    const attachedA = await latestEvent(stripe, "payment_method.attached",
      (o) => o["id"] === cardA.id);
    const transitionA = toTransition(attachedA);

    expect(transitionA.kind).toBe("card_saved");
    if (transitionA.kind !== "card_saved") return;
    expect(transitionA.paymentMethodId).toBe(cardA.id);
    expect(transitionA.stripeCustomerId).toBe(stripeCustomer.id);
    // Real payloads carry these; asserting it is the point of the exercise.
    expect(transitionA.last4).toMatch(/^\d{4}$/);
    expect(transitionA.brand).toBeTruthy();

    const attachedB = await latestEvent(stripe, "payment_method.attached",
      (o) => o["id"] === cardB.id);
    const transitionB = toTransition(attachedB);
    if (transitionB.kind !== "card_saved") throw new Error("card B did not map");

    const save = (t: typeof transitionA) =>
      sql(
        `select save_payment_method('${customerId}', '${t.paymentMethodId}',
           ${t.brand ? `'${t.brand}'` : "null"}, ${t.last4 ? `'${t.last4}'` : "null"},
           ${t.expMonth ?? "null"}, ${t.expYear ?? "null"})`,
      );

    expect(save(transitionA)).toBe("t"); // first card becomes the default
    expect(save(transitionB)).toBe("f"); // second does not steal it

    // THE REPLAY.
    expect(save(transitionA)).toBe("t");
    expect(
      sql(
        `select count(*) from payment_methods
         where customer_id = '${customerId}' and is_default and detached_at is null`,
      ),
    ).toBe("1");
    expect(
      sql(
        `select is_default from payment_methods
         where stripe_payment_method_id = '${cardA.id}'`,
      ),
    ).toBe("t");
  }, 90_000);

  /**
   * Two Checkout tabs. The local payment_operations row is the first
   * defence; this is the second — Stripe's own idempotency, which is what
   * still holds if two processes race past the first.
   */
  it("returns the same Checkout session for a repeated idempotency key", async () => {
    const key = `checkout:${invoiceId}:17000:0`;
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 17000,
            product_data: { name: `${CUSTOMER_BRAND} — live check` },
          },
        },
      ],
      metadata: { invoice_id: invoiceId, tip_cents: "0" },
      success_url: "https://example.invalid/paid",
      cancel_url: "https://example.invalid/canceled",
    };

    const first = await stripe.checkout.sessions.create(params, { idempotencyKey: key });
    const second = await stripe.checkout.sessions.create(params, { idempotencyKey: key });

    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
  }, 60_000);

  /**
   * A real capture, mapped and applied. `amount_received` vs `amount` is
   * exactly the kind of thing a hand-written fixture gets wrong.
   */
  it("settles an invoice from a real payment_intent.succeeded", async () => {
    const intent = await stripe.paymentIntents.create({
      amount: 17000,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { invoice_id: invoiceId },
    });
    expect(intent.status).toBe("succeeded");

    const event = await latestEvent(stripe, "payment_intent.succeeded",
      (o) => o["id"] === intent.id);
    const transition = toTransition(event);

    expect(transition.kind).toBe("payment_succeeded");
    if (transition.kind !== "payment_succeeded") return;
    expect(transition.invoiceId).toBe(invoiceId);
    expect(transition.amountCents).toBe(17000);
    expect(transition.paymentIntentId).toBe(intent.id);

    sql(
      `select record_payment('${transition.invoiceId}', ${transition.amountCents}, 0,
        '${transition.paymentIntentId}', null, null, false, 'card')`,
    );
    expect(sql(`select balance_cents from invoices where id = '${invoiceId}'`)).toBe("0");
    expect(sql(`select status from invoices where id = '${invoiceId}'`)).toBe("paid");
  }, 90_000);

  /**
   * A real dashboard-style refund: no stated intent, so `unattributed` —
   * fully credited, never re-collected, split 50/50.
   */
  it("splits a real unattributed refund 50/50 and leaves nothing collectible", async () => {
    const paid = sql(
      `select stripe_payment_intent_id from payments where invoice_id = '${invoiceId}' limit 1`,
    );
    expect(paid).toMatch(/^pi_/);

    const firstRefund = await stripe.refunds.create({ payment_intent: paid, amount: 2000 });
    const secondRefund = await stripe.refunds.create({ payment_intent: paid, amount: 3000 });

    const event = await latestEvent(stripe, "charge.refunded",
      (o) => o["payment_intent"] === paid);
    const transition = toTransition(event);
    if (transition.kind !== "charge_refunds_changed") throw new Error("charge event did not map");
    expect(transition.paymentIntentId).toBe(paid);
    const refunds = await listChargeRefunds(transition.chargeId, stripe);
    expect(refunds).toContainEqual({ id: firstRefund.id, amount: 2000, status: "succeeded" });
    expect(refunds).toContainEqual({ id: secondRefund.id, amount: 3000, status: "succeeded" });
    for (const delivery of [refunds, [...refunds].reverse()]) {
      for (const item of delivery) {
        if (item.status !== "succeeded") continue;
        sql(`select record_refund('${paid}', ${item.amount}, '${item.id}')`);
      }
    }

    // $170 in, $50 back: $120 retained, nothing outstanding, no new charge.
    expect(sql(`select balance_cents from invoices where id = '${invoiceId}'`)).toBe("0");
    expect(
      sql(`select amount_paid_cents - refunded_cents from invoices where id = '${invoiceId}'`),
    ).toBe("12000");
    expect(
      sql(
        `select coalesce(sum(amount_cents),0) from invoice_adjustments
         where invoice_id = '${invoiceId}' and category = 'service_refund'`,
      ),
    ).toBe("2500");
    expect(
      sql(
        `select coalesce(sum(amount_cents),0) from invoice_adjustments
         where invoice_id = '${invoiceId}' and category = 'goodwill'`,
      ),
    ).toBe("2500");
  }, 90_000);

  it("recovers a real tipped capture without creating another collection", async () => {
    const tippedInvoice = sql(
      `insert into invoices(customer_id,status,subtotal_cents,total_cents)
       values ('${customerId}','sent',17000,17000) returning id`,
    );
    const key = `sandbox-tipped-recovery:${tippedInvoice}`;
    expect(sql(
      `select outcome from begin_reviewed_payment_operation(
        '${tippedInvoice}','checkout','${key}',19000,17000,'${customerId}',2000)`,
    )).toBe("started");

    const intent = await stripe.paymentIntents.create({
      amount: 19000,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { invoice_id: tippedInvoice, tip_cents: "2000" },
    }, { idempotencyKey: key });
    expect(intent.livemode).toBe(false);
    expect(intent.status).toBe("succeeded");

    // Simulate a response that was lost before the local operation could save its provider reference.
    sql(`update payment_operations set expires_at=now()-interval '1 second' where idempotency_key='${key}'`);
    expect(sql(
      `select outcome from begin_reviewed_payment_operation(
        '${tippedInvoice}','autocharge','${key}:second',17000,17000,'${customerId}')`,
    )).toBe("blocked");

    const event = await latestEvent(stripe, "payment_intent.succeeded", (o) => o["id"] === intent.id);
    const transition = toTransition(event);
    if (transition.kind !== "payment_succeeded") throw new Error("tipped capture did not map");
    expect(transition).toMatchObject({
      invoiceId: tippedInvoice, paymentIntentId: intent.id, amountCents: 19000, tipCents: 2000,
    });
    sql(`select attach_payment_operation('${key}','payment_intent','${intent.id}',null)`);
    const recovered = await lookUpPaymentIntent(intent.id);
    if (recovered.state !== "paid") throw new Error("tipped capture did not recover");
    expect(recovered).toMatchObject({ amountCents: 19000, tipCents: 2000, paymentIntentId: intent.id });
    for (const receipt of [recovered, transition]) {
      sql(`select record_payment('${tippedInvoice}',${receipt.amountCents},${receipt.tipCents},
          '${intent.id}',null,null,false,'card');
        select settle_payment_operation_by_ref('${tippedInvoice}','${intent.id}')`);
    }
    expect(sql(`select status,tip_cents,total_cents,amount_paid_cents,balance_cents
      from invoices where id='${tippedInvoice}'`)).toBe("paid|2000|19000|19000|0");
    expect(sql(`select count(*) from payments where invoice_id='${tippedInvoice}'`)).toBe("1");
    expect(sql(`select state from payment_operations where invoice_id='${tippedInvoice}'`)).toBe("succeeded");
  }, 90_000);

  /**
   * The heuristic the auto-charge sweep leans on to tell a decline from an
   * unknown outcome — and getting that wrong is how the same money gets
   * taken twice. `isDecline` has only ever seen errors I invented.
   */
  it("produces a decline Stripe reports as such, not an ambiguous failure", async () => {
    const stripeCustomer = await stripe.customers.create({ name: "Declines" });
    // Attaches happily, then fails when charged off-session — the case the
    // retry schedule actually has to survive.
    await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", {
      customer: stripeCustomer.id,
    });

    let caught: unknown = null;
    try {
      await stripe.paymentIntents.create(
        {
          amount: 17000,
          currency: "usd",
          customer: stripeCustomer.id,
          payment_method: "pm_card_chargeCustomerFail",
          off_session: true,
          confirm: true,
        },
        { idempotencyKey: `live-decline:${randomUUID()}` },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    const type = (caught as { type?: string }).type;
    // This is what the sweep keys on. If Stripe ever stops reporting a
    // decline this way, the sweep would start treating it as "we do not
    // know" and hold the invoice instead of retrying — a visible stall
    // rather than a double charge, but still wrong, and this catches it.
    expect(type).toBe("StripeCardError");
  }, 90_000);
});
