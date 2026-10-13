import {describe,it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {MatchingHealthSection} from "./matching-health";
import type {MatchingHealth} from "@/lib/operations/matching-health";
const now=new Date("2026-10-12T15:26:00Z");
const row:MatchingHealth={observed_at:now.toISOString(),state_present:true,scheduler_count:1,scheduler_enabled:true,expected_interval:true,scheduler_status:"succeeded",scheduler_started_at:"2026-10-12T15:25:00Z",scheduler_finished_at:"2026-10-12T15:25:02Z",last_status:"success",last_started_at:"2026-10-12T15:25:01Z",last_finished_at:"2026-10-12T15:25:02Z",leased_until:"2026-10-12T15:25:02Z",last_result:{jobs:9,assigned:0,offered:0,needsScheduling:9,failed:0}};
describe("Office matching status rendering",()=>{
 it("renders the saved Dallas completion and actionable appointment result",()=>{const html=renderToStaticMarkup(createElement(MatchingHealthSection,{health:row,now}));expect(html).toContain("Running on schedule");expect(html).toContain("10:25");expect(html).toContain("Dallas time");expect(html).toContain("9 appointments needing review");expect(html).toContain('href="/admin/dispatch"');expect(html).toContain('href="/admin/automation"');expect(html).not.toContain("Supabase");});
 it("does not invent zero matching outcomes when a failed run lacks counts",()=>{const html=renderToStaticMarkup(createElement(MatchingHealthSection,{health:{...row,last_status:"failed",last_result:{}},now}));expect(html).toContain("Matching needs attention");expect(html).toContain("Detailed result counts are unavailable");expect(html).not.toContain("Saved result:");});
 it("shows explicit recovery when health cannot be loaded",()=>{const html=renderToStaticMarkup(createElement(MatchingHealthSection,{health:null,now}));expect(html).toContain("Matching status is unavailable");expect(html).toContain("Reload status");expect(html).not.toContain("Running on schedule");expect(html).not.toContain("Saved result:");});
});
