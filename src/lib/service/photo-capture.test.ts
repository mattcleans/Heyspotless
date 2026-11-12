import { describe, expect, it } from "vitest";
import { capturePath, readPhotoCapture, readPhotoCaptureReceipt } from "./photo-capture";
const jobId = "a1111111-1111-4111-8111-111111111111";
const revision = "a2222222-2222-4222-8222-222222222222";
const capture = { jobId, roomKey: "kitchen_1", kind: "before", revision, sha256: "a".repeat(64), supersedes: [], storagePath: capturePath(jobId, "kitchen_1", "before", revision) };
const receipt = { ...capture, recorded: true, photoId: "a3333333-3333-4333-8333-333333333333", objectId: "a4444444-4444-4444-8444-444444444444", objectVersion: "version-1" };
describe("capture protocol", () => {
  it("keeps retry paths stable and gives different retakes different paths", () => {
    expect(readPhotoCapture(capture)).toEqual(capture);
    expect(capturePath(jobId, "kitchen_1", "before", revision)).toBe(capture.storagePath);
    expect(capturePath(jobId, "kitchen_1", "before", receipt.objectId)).not.toBe(capture.storagePath);
  });
  it.each([{ storagePath: `jobs/${jobId}/kitchen_1-before.jpg` }, { sha256: "echo" }, { supersedes: [revision] }, { supersedes: [receipt.objectId, receipt.objectId] }, { revision: "../foreign" }])("rejects unsafe or ambiguous capture %j", change => {
    expect(readPhotoCapture({ ...capture, ...change })).toBeNull();
  });
  it.each([{ recorded: false }, { objectVersion: "" }, { objectId: undefined }, { sha256: "b".repeat(64) }, { revision: receipt.objectId }, { supersedes: [receipt.objectId] }])("never acknowledges different or unverified capture %j", change => {
    expect(readPhotoCaptureReceipt({ ...receipt, ...change }, capture as never)).toBeNull();
  });
  it("acknowledges the exact byte/object/capture receipt", () => expect(readPhotoCaptureReceipt(receipt, capture as never)).toEqual(receipt));
});
