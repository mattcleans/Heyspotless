import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "./fetch-with-timeout";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser network deadline", () => {
  it("aborts a request that never returns without retrying it", async () => {
    const fetcher = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const result = fetchWithTimeout("/api/jobs/photo", { method: "POST" });
    const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("also bounds a body stalled after response headers arrive", async () => {
    vi.stubGlobal("fetch", vi.fn((_input, init) => Promise.resolve(new Response(
      new ReadableStream({ start(stream) {
        init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
      } }),
    ))));
    const response = await fetchWithTimeout("/photo");
    const rejected = expect(response.json()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
    await rejected;
  });

  it.each([false, true])("preserves caller cancellation (Request input: %s)", async (requestInput) => {
    const parent = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetcher);
    await fetchWithTimeout(requestInput ? new Request("https://example.test/photo", { signal: parent.signal }) : "/photo",
      requestInput ? undefined : { signal: parent.signal });
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    const reason = new DOMException("User canceled", "AbortError");
    parent.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an already canceled signal", async () => {
    const parent = new AbortController(); parent.abort();
    const fetcher = vi.fn().mockResolvedValue(new Response("ok")); vi.stubGlobal("fetch", fetcher);
    await fetchWithTimeout("/photo", { signal: parent.signal });
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the response and request options on success", async () => {
    const response = new Response("saved");
    const fetcher = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetcher);
    expect(await fetchWithTimeout("/photo", { method: "POST", body: "bytes", credentials: "same-origin" })).toBe(response);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "bytes", credentials: "same-origin" });
  });
});
