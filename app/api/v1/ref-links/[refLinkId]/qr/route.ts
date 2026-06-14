import { NextRequest, NextResponse } from "next/server";
import { authorizeApiV1 } from "@/lib/api-auth";
import { refLinkQrSvg } from "@/lib/qr";

/**
 * GET /api/v1/ref-links/:refLinkId/qr — QR code for a ref link.
 * Returns { publicUrl, qrSvg }; qrSvg is server-generated SVG markup
 * (no third-party QR service). Workspace-scoped.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ refLinkId: string }> }
) {
  const { refLinkId } = await params;
  const gate = await authorizeApiV1(request);
  if (!gate.ok) return gate.response;
  const { auth, supabase } = gate;

  const { data: link } = await supabase
    .from("ref_links")
    .select("slug")
    .eq("id", refLinkId)
    .eq("workspace_id", auth.workspaceId)
    .single();

  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const publicUrl = `${appUrl}/r/${link.slug}`;
  const qrSvg = await refLinkQrSvg(publicUrl);

  return NextResponse.json({ publicUrl, qrSvg });
}
