import { verifySchedulerTarget } from "../src/lib/cron/scheduler-target.ts";

try {
  await verifySchedulerTarget(process.env.APP_URL, process.env.CRON_SECRET, fetch, {
    dispatchRead: process.argv.includes("--require-dispatch-read"),
  });
  console.log("Scheduler authentication and production database target verified.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
