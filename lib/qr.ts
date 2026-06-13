import QRCode from "qrcode";

/**
 * Render a ref-link URL as a self-contained, scalable QR code (SVG markup).
 *
 * Generated server-side with the `qrcode` library — no third-party QR service,
 * so codes work behind Cloudflare Access, leak no scan-intent metadata, and
 * stay available regardless of any external uptime. SVG is used because agency
 * ref-link QR codes are often printed (scalable, crisp at any size).
 */
export async function refLinkQrSvg(url: string): Promise<string> {
  if (!url) throw new Error("refLinkQrSvg: url is required");
  return QRCode.toString(url, { type: "svg", width: 300, margin: 1 });
}
