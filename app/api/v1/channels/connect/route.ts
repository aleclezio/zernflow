import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";
import { createZernioClient } from "@/lib/zernio-client";
import { getZernioKey } from "@/lib/workspace-keys";
import {
  getBoundProfileId,
  ProfileUnboundError,
  profileUnboundResponse,
} from "@/lib/zernio-scope";

/**
 * POST /api/v1/channels/connect
 *
 * Returns Zernio's OAuth/connect URL for the given platform.
 * Zernio handles the entire connection flow (OAuth, page selection, etc.)
 * and redirects back to our callback URL when done.
 */
export async function POST(request: NextRequest) {
  const gate = await authorizeApiV1(request, "write");
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const apiKey = await getZernioKey(supabase, auth.workspaceId);
  if (!apiKey) {
    return NextResponse.json(
      { error: "Zernio API key not configured. Go to Settings first." },
      { status: 400 }
    );
  }

  const { platform } = await request.json();

  const supported = ["facebook", "instagram", "twitter", "telegram", "bluesky", "reddit"];
  if (!platform || !supported.includes(platform)) {
    return NextResponse.json(
      { error: `Unsupported platform. Must be one of: ${supported.join(", ")}` },
      { status: 400 }
    );
  }

  const zernio = createZernioClient(apiKey);

  // Connect is always scoped to the workspace's bound profile — never a
  // "first profile of the key" fallback.
  let profileId: string;
  try {
    profileId = await getBoundProfileId(supabase, auth.workspaceId);
  } catch (err) {
    if (err instanceof ProfileUnboundError) return profileUnboundResponse();
    throw err;
  }

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const callbackUrl = `${appUrl}/dashboard/channels/callback`;

    // Zernio handles everything: OAuth, page selection, Bluesky credentials, Telegram code
    const res = await zernio.connect.getConnectUrl({
      path: { platform },
      query: { profileId, redirect_url: callbackUrl },
    });

    if (!res.data?.authUrl) {
      return NextResponse.json({ error: "Failed to get connect URL" }, { status: 500 });
    }

    return NextResponse.json({ authUrl: res.data.authUrl });
  } catch (error) {
    console.error("Failed to get connect URL:", error);
    return NextResponse.json(
      { error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
