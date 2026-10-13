import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { PHOTO_BUCKET } from "@/lib/offline/bucket";
import { isReviewId } from "@/lib/operations/visit-review";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };
export async function GET(request: NextRequest, {params}: {params:Promise<{id:string;photoId:string}>}) {
  const {id,photoId} = await params;
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({error:"Sign in with your management account to view photos."},{status:401,headers});
  if (profile.role !== "admin") return NextResponse.json({error:"Management access required."},{status:403,headers});
  if (repo.isDemo || !isReviewId(id) || !isReviewId(photoId)) return NextResponse.json({error:"Photo not found."},{status:404,headers});
  const unavailable = () => NextResponse.redirect(new URL(`/admin/visits/${id}?photoError=unavailable`,request.url),{status:303,headers});
  try {
    const db = await createClient();
    const {data,error} = await db.from("job_photos").select("storage_path").eq("id",photoId).eq("job_id",id).maybeSingle();
    if (error) return unavailable();
    if (!data) return NextResponse.json({error:"Photo not found."},{status:404,headers});
    const path = data.storage_path;
    if (typeof path !== "string" || !path.startsWith(`jobs/${id}/`) || path.includes("..")) return unavailable();
    const signed = await db.storage.from(PHOTO_BUCKET).createSignedUrl(path,60);
    if (signed.error || !signed.data?.signedUrl) return unavailable();
    return NextResponse.redirect(signed.data.signedUrl,{status:303,headers});
  } catch { return unavailable(); }
}
