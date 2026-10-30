import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isChangeFeeKind, readChangeFeeReceipt, type ChangeFeeReview } from "./change-fee";
import { InvoiceReviewChanged } from "./invoice-issue-store";
export async function listDraftChangeFees(db: SupabaseClient, page: number) {
  const {data,error,count}=await db.from("invoices").select("id,kind,total_cents,created_at",{count:"exact"})
    .in("kind",["cancellation_fee","reschedule_fee"]).eq("status","draft").is("issued_at",null).is("voided_at",null)
    .order("created_at",{ascending:true}).order("id",{ascending:true}).range((page-1)*25,page*25-1);
  if(error) throw new Error("Fee review unavailable");
  return {items:(data??[]).filter(i=>isChangeFeeKind(i.kind)),total:count??0};
}
export async function loadChangeFeeReview(db: SupabaseClient, invoiceId: string): Promise<ChangeFeeReview|null> {
  const {data:i,error}=await db.from("invoices").select("id,customer_id,job_id,kind,status,total_cents,due_on,issued_at,voided_at").eq("id",invoiceId).maybeSingle();
  if(error) throw new Error("Fee review unavailable");
  if(!i || !isChangeFeeKind(i.kind) || i.job_id!==null || i.voided_at || i.total_cents!==6000) return null;
  const cancellation=i.kind==="cancellation_fee";
  const {data:c,error:ce}=await db.from(cancellation?"visit_cancellations":"visit_reschedules")
    .select(cancellation?"id,job_id,customer_id,fee_cents,billing_review,canceled_at":"id,job_id,customer_id,fee_cents,confirmed_at")
    .eq("invoice_id",invoiceId).maybeSingle();
  if(ce) throw new Error("Fee review unavailable");
  const change=c as unknown as Record<string,unknown>|null;
  if(!change || change.customer_id!==i.customer_id || change.fee_cents!==i.total_cents || (cancellation && change.billing_review!==false)) return null;
  const [jr,cr]=await Promise.all([
    db.from("jobs").select("id,customer_id").eq("id",String(change.job_id)).maybeSingle(),
    db.from("customers").select("id,first_name,last_name").eq("id",i.customer_id).maybeSingle(),
  ]);
  if(jr.error || cr.error) throw new Error("Fee review unavailable");
  if(!jr.data || jr.data.customer_id!==i.customer_id || !cr.data) return null;
  return {invoiceId:i.id,changeId:String(change.id),visitId:jr.data.id,customerId:i.customer_id,
    customerName:`${cr.data.first_name} ${cr.data.last_name??""}`.trim(),kind:i.kind,totalCents:i.total_cents,
    dueOn:i.due_on,issuedAt:i.issued_at,status:i.status,changedAt:String(cancellation?change.canceled_at:change.confirmed_at)};
}
export async function issueChangeFee(db:SupabaseClient,review:ChangeFeeReview,actor:string,dueOn:string) {
  const {data,error}=await db.rpc("issue_reviewed_change_fee",{p_invoice:review.invoiceId,p_change:review.changeId,p_kind:review.kind,p_actor:actor,p_reviewed_total:review.totalCents,p_due:dueOn});
  if(error) {if(error.code==="PIF01") throw new InvoiceReviewChanged();throw new Error("Fee issuance unavailable");}
  const receipt=readChangeFeeReceipt(data,{...review,dueOn});
  if(!receipt) throw new Error("Fee issuance unconfirmed");
  return receipt;
}
