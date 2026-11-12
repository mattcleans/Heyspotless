import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHOTO_PROOF_TIMEOUT_MS, verifyPhotoObject } from "./photo-object-proof";
const bytes = "new captured bytes";
const digest = createHash("sha256").update(bytes).digest("hex");
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("actual stored photo byte proof", () => {
  it("verifies the actual streamed bytes and skips caches", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    await expect(verifyPhotoObject("https://storage.example.test/private-object", digest, bytes.length)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });
  it.each([["old captured bytes", bytes.length], [bytes, bytes.length + 1], [bytes, bytes.length - 1]] as const)("refuses unexpected contents %s or size %s", async (stored, size) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stored)));
    await expect(verifyPhotoObject("https://storage.example.test/private-object", digest, size)).rejects.toThrow();
  });
  it("bounds stalled response bodies and cancels their reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const check = expect(verifyPhotoObject("https://storage.example.test/private-object", digest, bytes.length)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(PHOTO_PROOF_TIMEOUT_MS);
    await check;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
