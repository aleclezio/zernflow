import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/admin-auth";
import { onboardClient, OnboardError, type OnboardClientInput } from "@/lib/onboard";

/**
 * POST /api/admin/onboard-client
 *
 * Operator-only: stands up a full ZernFlow tenant in one call (workspace +
 * owner, Zernio profile bind + channel sync, operator membership, scoped key,
 * inbound webhook). Thin wrapper over lib/onboard.ts so the CLI and the
 * command-centre "Add client" button share one implementation.
 *
 * Auth: ONBOARD_ADMIN_TOKEN Bearer (plus the Cloudflare Access edge in prod).
 * The request body carries the client's Zernio key; it is passed to the engine
 * and NEVER logged. The issued scoped key is returned exactly once.
 */
const STATUS_BY_CODE: Record<string, number> = {
  PROFILE_ALREADY_BOUND: 409,
  PROFILE_MISMATCH: 409,
  PROFILE_CHOICE_REQUIRED: 422,
};

export async function POST(request: NextRequest) {
  if (!requireAdminAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "";
  const zernioApiKey = typeof body.zernioApiKey === "string" ? body.zernioApiKey : "";
  if (!name || !ownerUserId || !zernioApiKey.trim()) {
    return NextResponse.json(
      { error: "name, ownerUserId and zernioApiKey are required" },
      { status: 400 }
    );
  }

  const input: OnboardClientInput = {
    name,
    ownerUserId,
    zernioApiKey,
    slug: typeof body.slug === "string" ? body.slug : undefined,
    profileId: typeof body.profileId === "string" ? body.profileId : undefined,
    operatorUserId: typeof body.operatorUserId === "string" ? body.operatorUserId : undefined,
    keyName: typeof body.keyName === "string" ? body.keyName : undefined,
    keyScopes: Array.isArray(body.keyScopes) ? body.keyScopes : undefined,
    appUrl: typeof body.appUrl === "string" ? body.appUrl : undefined,
    webhookZernioKey: typeof body.webhookZernioKey === "string" ? body.webhookZernioKey : undefined,
  };

  try {
    const result = await onboardClient(input);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof OnboardError) {
      const status = (e.code && STATUS_BY_CODE[e.code]) || 400;
      return NextResponse.json({ error: e.message, step: e.step, code: e.code }, { status });
    }
    // Never echo an unexpected error body — it could embed a secret.
    console.error("onboard-client: unexpected failure");
    return NextResponse.json({ error: "Onboarding failed" }, { status: 500 });
  }
}
