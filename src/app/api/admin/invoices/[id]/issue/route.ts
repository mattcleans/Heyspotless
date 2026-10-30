import { NextResponse,type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { isReviewId } from "@/lib/operations/visit-review";
import { isChangeFeeKind } from "@/lib/operations/change-fee";
import { loadChangeFeeReview,issueChangeFee } from "@/lib/operations/change-fee-store";
import { InvoiceReviewChanged } from "@/lib/operations/invoice-issue-store";
import { toCalendarDate } from "@/lib/time/zone";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const reply=(body:object,status=200)=>NextResponse.json(body,{status,headers:{"cache-control":"private, no-store",vary:"Cookie"}});
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}) {
  const repo=await getRepository(),profile=await repo.getCurrentProfile();
  if(!profile) return reply({message:"Sign in to Management."},401);
  if(profile.role!=="admin") return reply({message:"Management access is required."},403);
  if(repo.isDemo) return reply({message:"Sample fees cannot be issued."},503);
  const origin=request.headers.get("origin");
  if(origin && origin!==new URL(request.url).origin) return reply({message:"Refresh this fee."},403);
  const {id}=await context.params;
  if(!isReviewId(id)) return reply({message:"Choose a valid invoice."},400);
  let value:unknown;
  try {value=await request.json();}catch{return reply({message:"Review the fee first."},400);}
  const b=value && typeof value==="object"?value as Record<string,unknown>:{};
  const dueOn=toCalendarDate(b.dueOn);
  if(typeof b.changeId!=="string" || !isReviewId(b.changeId) || !isChangeFeeKind(b.kind) || b.reviewedTotalCents!==6000 || !dueOn || b.confirmed!==true) return reply({message:"Review the exact fee, change and due date."},400);
  try {
    const db=createAdminClient(),review=await loadChangeFeeReview(db,id);
    if(!review) return reply({message:"Change fee not found."},404);
    if(review.changeId!==b.changeId || review.kind!==b.kind || review.totalCents!==b.reviewedTotalCents) return reply({code:"review_changed",message:"The fee changed. Refresh and review it again."},409);
    return reply(await issueChangeFee(db,review,profile.id,dueOn));
  }catch(error){return error instanceof InvoiceReviewChanged?reply({code:"review_changed",message:"The fee changed. Refresh and review it again."},409):reply({message:"Issuance could not be confirmed. Refresh the fee before trying again."},503);}
}
