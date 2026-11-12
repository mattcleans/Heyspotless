import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const verify = vi.hoisted(() => vi.fn());
vi.mock("./photo-object-proof", () => ({ verifyPhotoObject: verify }));
import { PhotoReceiptError, ServiceStore } from "./store";
import { capturePath } from "./photo-capture";
const input = { jobId: "a1111111-1111-4111-8111-111111111111", cleanerId: "a2222222-2222-4222-8222-222222222222", revision: "a3333333-3333-4333-8333-333333333333", roomKey: "kitchen_1", kind: "before" as const, sha256: "a".repeat(64), supersedes: [] as string[], storagePath: "" };
input.storagePath = capturePath(input.jobId, input.roomKey, input.kind, input.revision);
const objectId="a4444444-4444-4444-8444-444444444444";
const photoId="a5555555-5555-4555-8555-555555555555";
const receipt={...input,recorded:true,photoId,objectId,objectVersion:"object-version"};
const rpc=vi.fn();const sign=vi.fn();
const client={rpc,storage:{from:()=>({createSignedUrl:sign})}} as unknown as SupabaseClient;
beforeEach(()=>{
 vi.resetAllMocks();verify.mockResolvedValue(undefined);
 rpc.mockImplementation(async name=> name==="job_photo_upload_candidate" ? {data:{objectId,objectVersion:"object-version",byteSize:3},error:null} : {data:receipt,error:null});
 sign.mockResolvedValue({data:{signedUrl:"https://storage.example.test/private-object"},error:null});
});
describe("server capture byte/object receipt",()=>{
 it("hashes actual stored bytes before the guarded recording write",async()=>{
  expect(await new ServiceStore(client).recordPhoto(input)).toEqual(receipt);
  expect(verify).toHaveBeenCalledWith("https://storage.example.test/private-object",input.sha256,3);
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]!);
  expect(rpc.mock.calls[1]).toEqual(["record_job_photo_capture",expect.objectContaining({p_object:objectId,p_object_version:"object-version",p_sha256:input.sha256,p_revision:input.revision,p_byte_size:3})]);
 });
 it("does not record or echo success when stored bytes do not match",async()=>{
  verify.mockRejectedValue(new Error("old object contents"));
  await expect(new ServiceStore(client).recordPhoto(input)).rejects.toBeInstanceOf(PhotoReceiptError);
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it("refuses missing object/version metadata before requesting photo bytes",async()=>{
  rpc.mockResolvedValue({data:{objectId,byteSize:3},error:null});
  await expect(new ServiceStore(client).recordPhoto(input)).rejects.toBeInstanceOf(PhotoReceiptError);
  expect(sign).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
 });
 it("does not acknowledge a database rejection after bytes verified",async()=>{
  rpc.mockImplementation(async name=>name==="job_photo_upload_candidate"?{data:{objectId,objectVersion:"object-version",byteSize:3},error:null}:{data:null,error:{code:"PPH01"}});
  await expect(new ServiceStore(client).recordPhoto(input)).rejects.toBeInstanceOf(PhotoReceiptError);
  expect(verify).toHaveBeenCalledOnce();
 });
 it("refuses a receipt for different bytes despite a successful database response",async()=>{
  rpc.mockImplementation(async name=>name==="job_photo_upload_candidate"?{data:{objectId,objectVersion:"object-version",byteSize:3},error:null}:{data:{...receipt,sha256:"b".repeat(64)},error:null});
  expect(await new ServiceStore(client).recordPhoto(input)).toBeNull();
 });
});
