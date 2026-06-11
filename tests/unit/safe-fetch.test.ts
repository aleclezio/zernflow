import { describe, it, expect } from "vitest";
import { isPrivateAddress, assertSafeUrl, safeFetch, SsrfError } from "@/lib/flow-engine/safe-fetch";

describe("isPrivateAddress", () => {
  const PRIVATE = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "0.1.2.3",
    "::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped v6
    "::ffff:10.0.0.1",
    "::ffff:192.168.0.1",
  ];
  const PUBLIC = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above
    "11.0.0.1",
    "193.168.1.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ];

  for (const ip of PRIVATE) {
    it(`flags ${ip} as private/reserved`, () => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
  }
  for (const ip of PUBLIC) {
    it(`allows public ${ip}`, () => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  }
});

describe("assertSafeUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => assertSafeUrl("ftp://example.com/x")).toThrow(SsrfError);
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertSafeUrl("gopher://example.com")).toThrow(SsrfError);
  });

  it("rejects invalid URLs", () => {
    expect(() => assertSafeUrl("not a url")).toThrow(SsrfError);
  });

  it("accepts well-formed http(s) URLs (resolution happens at fetch time)", () => {
    expect(() => assertSafeUrl("https://api.example.com/hook")).not.toThrow();
    expect(() => assertSafeUrl("http://api.example.com:8080/hook")).not.toThrow();
  });
});

describe("safeFetch (negative paths, no external network)", () => {
  it("blocks loopback literals", async () => {
    await expect(safeFetch("http://127.0.0.1:9/x", { method: "GET" })).rejects.toThrow(SsrfError);
  });

  it("blocks decimal-literal IPv4 (2130706433 = 127.0.0.1)", async () => {
    await expect(safeFetch("http://2130706433/x", { method: "GET" })).rejects.toThrow(SsrfError);
  });

  it("blocks the cloud metadata endpoint", async () => {
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/", { method: "GET" })
    ).rejects.toThrow(SsrfError);
  });

  it("blocks private-range literals", async () => {
    await expect(safeFetch("http://192.168.1.1/admin", { method: "GET" })).rejects.toThrow(SsrfError);
    await expect(safeFetch("http://[::1]:3000/", { method: "GET" })).rejects.toThrow(SsrfError);
  });
});
