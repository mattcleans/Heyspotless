/** Capture identities are independent of the room slot and of device clocks. */
export const CAPTURE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PhotoCapture {
  jobId: string;
  roomKey: string;
  kind: "before" | "after" | "issue";
  storagePath: string;
  revision: string;
  sha256: string;
  supersedes: string[];
}
export interface PhotoCaptureReceipt extends PhotoCapture {
  recorded: true;
  photoId: string;
  objectId: string;
  objectVersion: string;
}
export function capturePath(jobId: string, roomKey: string, kind: string, revision: string): string {
  return `jobs/${jobId}/${roomKey}-${kind}/${revision}.jpg`;
}
export function readPhotoCapture(value: unknown): PhotoCapture | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.jobId !== "string" || !CAPTURE_UUID.test(v.jobId) ||
      typeof v.revision !== "string" || !CAPTURE_UUID.test(v.revision) ||
      typeof v.roomKey !== "string" || !/^(kitchen|bathroom|half_bath|living_room|bedroom|utility_room)_[1-9][0-9]{0,2}$/.test(v.roomKey) ||
      !["before", "after", "issue"].includes(String(v.kind)) ||
      typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256) ||
      !Array.isArray(v.supersedes) || v.supersedes.length > 64 ||
      !v.supersedes.every(r => typeof r === "string" && CAPTURE_UUID.test(r) && r !== v.revision) ||
      new Set(v.supersedes).size !== v.supersedes.length ||
      v.storagePath !== capturePath(v.jobId, v.roomKey, String(v.kind), v.revision)) return null;
  return v as unknown as PhotoCapture;
}
export function readPhotoCaptureReceipt(value: unknown, expected: PhotoCapture): PhotoCaptureReceipt | null {
  const capture = readPhotoCapture(value);
  if (!capture || !value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.recorded !== true || typeof v.photoId !== "string" || !CAPTURE_UUID.test(v.photoId) ||
      typeof v.objectId !== "string" || !CAPTURE_UUID.test(v.objectId) ||
      typeof v.objectVersion !== "string" || !v.objectVersion ||
      capture.jobId !== expected.jobId || capture.roomKey !== expected.roomKey || capture.kind !== expected.kind ||
      capture.storagePath !== expected.storagePath || capture.revision !== expected.revision || capture.sha256 !== expected.sha256 ||
      JSON.stringify(capture.supersedes) !== JSON.stringify(expected.supersedes)) return null;
  return v as unknown as PhotoCaptureReceipt;
}
