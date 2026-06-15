import { describe, it, expect } from "vitest";
import { botFieldVars } from "@/lib/flow-engine/bot-fields";
import { interpolateVariables } from "@/lib/flow-engine/interpolate";

describe("botFieldVars", () => {
  it("namespaces each field under bot.<slug>", () => {
    expect(
      botFieldVars([
        { slug: "businessName", value: "Acme" },
        { slug: "hours", value: "9-5" },
      ])
    ).toEqual({ "bot.businessName": "Acme", "bot.hours": "9-5" });
  });

  it("returns an empty map for no fields", () => {
    expect(botFieldVars([])).toEqual({});
  });
});

describe("interpolateVariables with bot fields", () => {
  it("resolves {{bot.slug}} dotted keys", () => {
    const vars = { ...botFieldVars([{ slug: "businessName", value: "Acme" }]), first_name: "Jo" };
    expect(interpolateVariables("Hi {{first_name}}, welcome to {{bot.businessName}}!", vars)).toBe(
      "Hi Jo, welcome to Acme!"
    );
  });

  it("leaves unknown keys literal", () => {
    expect(interpolateVariables("{{bot.missing}}", {})).toBe("{{bot.missing}}");
  });
});
