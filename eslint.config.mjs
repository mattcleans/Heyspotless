import next from "eslint-config-next";

/**
 * eslint-config-next 16 ships a native flat config, so no FlatCompat shim.
 * (The shim throws "Converting circular structure to JSON" against this version.)
 */
const config = [
  ...next,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "supabase/**"],
  },
];

export default config;
