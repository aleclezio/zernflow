import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { anonClient, serviceClient } from "./helpers";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => anonClient(),
  createServiceClient: async () => serviceClient(),
}));

import { GET as jobsGET } from "@/app/api/cron/jobs/route";
import { GET as sequencesGET } from "@/app/api/cron/sequences/route";
import { GET as broadcastsGET } from "@/app/api/cron/broadcasts/route";

const SECRET = process.env.CRON_SECRET!;

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe("cron route auth", () => {
  it("REJECTS the legacy ?key= query parameter (secrets must not ride URLs)", async () => {
    const res = await jobsGET(req(`http://localhost:3000/api/cron/jobs?key=${SECRET}`));
    expect(res.status).toBe(401);

    const res2 = await sequencesGET(
      req(`http://localhost:3000/api/cron/sequences?key=${SECRET}`)
    );
    expect(res2.status).toBe(401);

    const res3 = await broadcastsGET(
      req(`http://localhost:3000/api/cron/broadcasts?key=${SECRET}`)
    );
    expect(res3.status).toBe(401);
  });

  it("rejects a wrong Bearer token", async () => {
    const res = await jobsGET(
      req("http://localhost:3000/api/cron/jobs", { authorization: "Bearer wrong" })
    );
    expect(res.status).toBe(401);

    const res2 = await broadcastsGET(
      req("http://localhost:3000/api/cron/broadcasts", { authorization: "Bearer wrong" })
    );
    expect(res2.status).toBe(401);
  });

  it("accepts the correct Bearer token", async () => {
    const res = await jobsGET(
      req("http://localhost:3000/api/cron/jobs", { authorization: `Bearer ${SECRET}` })
    );
    expect(res.status).toBe(200);

    const res2 = await sequencesGET(
      req("http://localhost:3000/api/cron/sequences", { authorization: `Bearer ${SECRET}` })
    );
    expect(res2.status).toBe(200);

    const res3 = await broadcastsGET(
      req("http://localhost:3000/api/cron/broadcasts", { authorization: `Bearer ${SECRET}` })
    );
    expect(res3.status).toBe(200);
  });
});
