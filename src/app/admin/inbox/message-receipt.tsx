import type { InboxMessage } from "@/lib/messaging/threads";
import { arrivalTextReceipt } from "@/lib/messaging/arrival-receipt";

export function MessageReceipt({ message }: { message: Pick<InboxMessage, "channel" | "direction" | "providerId" | "failedReason"> }) {
  if (message.channel !== "sms" || message.direction !== "outbound") return null;
  const receipt = arrivalTextReceipt({ providerId: message.providerId ?? null, failedReason: message.failedReason ?? null });
  return <div className="mt-2 border-t border-line pt-2 text-xs text-ink-2">
    <p className="font-semibold">{receipt.state === "accepted" ? "Submitted · delivery unconfirmed" : "Delivery unconfirmed · needs review"}</p>
    {receipt.state !== "accepted" && <p className="mt-1">Check the request in Twilio before sending another message.</p>}
    <details className="mt-1"><summary className="min-h-11 cursor-pointer py-3 font-semibold">Message request details</summary><div className="space-y-2 break-words">
      <p className="break-all">Provider reference: {message.providerId || "Not saved"}</p>
      {message.failedReason && <p>Recorded error: {message.failedReason}</p>}
    </div></details>
  </div>;
}
