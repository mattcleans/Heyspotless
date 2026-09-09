/**
 * Stand-in for the `server-only` package under Vitest.
 *
 * That package exists to make a build fail if server code is imported into a
 * Client Component, and it does it by throwing on import. Tests have no such
 * distinction and run in node, so importing a server module — BillingStore,
 * for one — would throw before a single assertion ran. Aliased in
 * vitest.config.mts; nothing imports this directly.
 */
export {};
