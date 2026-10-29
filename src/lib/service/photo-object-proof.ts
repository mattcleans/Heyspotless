import "server-only";
import { createHash } from "node:crypto";

export const PHOTO_PROOF_TIMEOUT_MS = 20_000;
/** Hash the actual private object stream; an echoed client hash is not proof. */
export async function verifyPhotoObject(url: string, expectedHash: string, expectedSize: number): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error("Invalid object size");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  controller.signal.addEventListener("abort", () => { void reader?.cancel().catch(() => undefined); }, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error("Photo object unavailable");
        reader = response.body.getReader();
        const hash = createHash("sha256");
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > expectedSize) throw new Error("Photo object size changed");
            hash.update(value);
          }
          if (size !== expectedSize || hash.digest("hex") !== expectedHash) throw new Error("Photo object bytes changed");
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Photo verification timed out")); }, PHOTO_PROOF_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
