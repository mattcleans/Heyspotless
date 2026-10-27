import { describe, expect, it } from "vitest";
import { customTipAmount, requestedTipCents } from "./tip-input";

describe("custom dollar tip", () => {
  it.each([["",0],["  ",0],["0",0],["5",500],["5.",500],["5.01",501],[".25",25],["0005.50",550],[" 5.50 ",550],["199.00",19900]] as const)("parses %s as %s cents",(value,cents)=>{
    expect(customTipAmount(value,19900)).toEqual({cents,error:null});
  });
  it.each(["-5","-0","+5","1e2","5,00","$5","1.234","1..2",".","NaN","Infinity","200","999999999999999999999999"])("refuses %s instead of silently changing the tip",value=>{
    expect(customTipAmount(value,19900).error).toBeTypeOf("string");
    expect(customTipAmount(value,19900).cents).toBe(0);
  });
});
describe("API whole cents",()=>{
  it.each([0,1,3980,2147483647])("accepts %s",value=>expect(requestedTipCents(value)).toBe(value));
  it("treats an omitted tip as no change",()=>expect(requestedTipCents(undefined)).toBe(0));
  it.each([null,"5",-1,0.5,NaN,Infinity,2147483648,Number.MAX_SAFE_INTEGER])("refuses %s without rounding or clamping",value=>expect(requestedTipCents(value)).toBeNull());
});
