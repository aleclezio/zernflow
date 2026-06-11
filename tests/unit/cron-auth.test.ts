import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { requireCronAuth } from "@/lib/cron-auth";

const SECRET = randomBytes(24).toString("base64url");
const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL;
});

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("requireCronAuth", () => {
  it("accepts a correct Bearer token", () => {
    expect(
      requireCronAuth(req("http://x/api/cron/jobs", { authorization: `Bearer ${SECRET}` }))
    ).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    expect(
      requireCronAuth(req("http://x/api/cron/jobs", { authorization: "Bearer nope" }))
    ).toBe(false);
  });

  it("rejects requests without an Authorization header", () => {
    expect(requireCronAuth(req("http://x/api/cron/jobs"))).toBe(false);
  });

  it("ignores the legacy ?key= query parameter (URL secrets leak into logs)", () => {
    expect(requireCronAuth(req(`http://x/api/cron/jobs?key=${SECRET}`))).toBe(false);
  });

  it("refuses everything when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(
      requireCronAuth(req("http://x/api/cron/jobs", { authorization: "Bearer " }))
    ).toBe(false);
    expect(requireCronAuth(req("http://x/api/cron/jobs"))).toBe(false);
  });

  it("refuses when CRON_SECRET is empty", () => {
    process.env.CRON_SECRET = "";
    expect(
      requireCronAuth(req("http://x/api/cron/jobs", { authorization: "Bearer " }))
    ).toBe(false);
  });
});
