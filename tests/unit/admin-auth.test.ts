import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAdminAuth } from "@/lib/admin-auth";

const SECRET = randomBytes(24).toString("base64url");
const ORIGINAL = process.env.ONBOARD_ADMIN_TOKEN;

beforeEach(() => {
  process.env.ONBOARD_ADMIN_TOKEN = SECRET;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONBOARD_ADMIN_TOKEN;
  else process.env.ONBOARD_ADMIN_TOKEN = ORIGINAL;
});

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://x/api/admin/onboard-client", { method: "POST", headers });
}

describe("requireAdminAuth", () => {
  it("accepts a correct Bearer token", () => {
    expect(requireAdminAuth(req({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    expect(requireAdminAuth(req({ authorization: "Bearer nope" }))).toBe(false);
  });

  it("rejects an empty Bearer value", () => {
    expect(requireAdminAuth(req({ authorization: "Bearer " }))).toBe(false);
  });

  it("rejects requests without an Authorization header", () => {
    expect(requireAdminAuth(req())).toBe(false);
  });

  it("ignores a ?token= query param (URL secrets leak into logs)", () => {
    const r = new NextRequest(`http://x/api/admin/onboard-client?token=${SECRET}`, { method: "POST" });
    expect(requireAdminAuth(r)).toBe(false);
  });

  it("refuses everything when ONBOARD_ADMIN_TOKEN is unset", () => {
    delete process.env.ONBOARD_ADMIN_TOKEN;
    expect(requireAdminAuth(req({ authorization: `Bearer ${SECRET}` }))).toBe(false);
    expect(requireAdminAuth(req())).toBe(false);
  });

  it("refuses when ONBOARD_ADMIN_TOKEN is empty", () => {
    process.env.ONBOARD_ADMIN_TOKEN = "";
    expect(requireAdminAuth(req({ authorization: `Bearer ${SECRET}` }))).toBe(false);
  });
});
