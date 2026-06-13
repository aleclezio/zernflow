import { describe, it, expect } from "vitest";
import { refLinkQrSvg } from "@/lib/qr";

describe("refLinkQrSvg", () => {
  it("returns scalable SVG markup for a URL", async () => {
    const svg = await refLinkQrSvg("https://os.lygge.com/r/abc12345");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg.length).toBeGreaterThan(100);
  });

  it("encodes different URLs into different codes", async () => {
    const a = await refLinkQrSvg("https://os.lygge.com/r/aaaaaaaa");
    const b = await refLinkQrSvg("https://os.lygge.com/r/bbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("rejects an empty value rather than emitting a blank code", async () => {
    await expect(refLinkQrSvg("")).rejects.toThrow();
  });
});
