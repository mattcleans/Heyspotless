import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareWorkShell } from "./device";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("offline preparation recovery", () => {
  it("reports unsupported worker storage rather than claiming offline availability", async () => {
    vi.stubGlobal("navigator", {});
    await expect(prepareWorkShell()).rejects.toThrow(
      "Offline reopening unavailable",
    );
  });
  it("does not leave preparation pending when an install never produces an active worker", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async () => ({})),
        ready: new Promise(() => {}),
      },
    });
    const result = expect(prepareWorkShell()).rejects.toThrow(
      "Offline reopening unavailable",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await result;
  });
  it("does not mistake an older push-only worker for an offline-ready worker", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async () => ({})),
        ready: Promise.resolve({ active: { postMessage } }),
        addEventListener: vi.fn(),
        removeEventListener,
      },
    });
    const result = expect(prepareWorkShell()).rejects.toThrow(
      "Offline reopening unavailable",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await result;
    expect(postMessage).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalled();
  });
});
