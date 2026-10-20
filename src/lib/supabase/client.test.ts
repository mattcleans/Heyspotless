import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "./client";
import { CLIENT_REQUEST_TIMEOUT_MS } from "../http/fetch-with-timeout";

vi.mock("./env", () => ({
  requireSupabaseConfig: () => ({ url: "https://synthetic.supabase.co", anonKey: "synthetic-public-key" }),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("the real Storage SDK settles a stalled upload after the browser deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fetcher = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetcher);
  let settled = false;
  const upload = createClient().storage.from("photos").upload("synthetic/photo.jpg", new Blob(["synthetic"]))
    .then((result) => { settled = true; return result; });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
  expect(settled).toBe(true);
  const result = await upload;
  expect(result.error).not.toBeNull();
  expect(result.error?.message).toMatch(/timed out/i);
  expect(fetcher).toHaveBeenCalledOnce();
});
