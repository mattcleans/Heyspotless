// Runs BEFORE the TypeScript scripts, in plain JavaScript, because the check
// cannot live inside them: on a Node older than 22.6,
// `node --experimental-strip-types` is an unknown flag and Node exits with
// "bad option" before a line of the script runs. That message says nothing
// about which version is needed; this one does.
//
//   node scripts/check-node.mjs && node --experimental-strip-types scripts/x.ts

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `This script needs Node 22.6 or newer (it runs TypeScript with --experimental-strip-types).\n` +
      `You have Node ${process.versions.node}. Install a current LTS — e.g. \`nvm install 22\` — and run it again.`,
  );
  process.exit(1);
}
