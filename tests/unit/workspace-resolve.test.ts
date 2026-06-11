import { describe, it, expect } from "vitest";
import { resolveWorkspaceId } from "@/lib/workspace-resolve";

// The unified shell (command-centre) sets active_profile_id for the selected
// client; ZernFlow must land on the workspace bound to that profile even if
// the operator's own zernflow_workspace_id cookie points elsewhere.

const memberships = [
  { workspace_id: "ws-a", zernio_profile_id: "profile-a" },
  { workspace_id: "ws-b", zernio_profile_id: "profile-b" },
];

describe("resolveWorkspaceId", () => {
  it("active_profile_id wins over the workspace cookie", () => {
    expect(
      resolveWorkspaceId(memberships, {
        activeProfileId: "profile-b",
        workspaceId: "ws-a",
      }),
    ).toBe("ws-b");
  });

  it("profile matching no accessible workspace falls back to the workspace cookie", () => {
    expect(
      resolveWorkspaceId(memberships, {
        activeProfileId: "profile-unknown",
        workspaceId: "ws-a",
      }),
    ).toBe("ws-a");
  });

  it("missing/empty profile cookie uses the workspace cookie", () => {
    expect(resolveWorkspaceId(memberships, { workspaceId: "ws-b" })).toBe("ws-b");
    expect(
      resolveWorkspaceId(memberships, { activeProfileId: "", workspaceId: "ws-b" }),
    ).toBe("ws-b");
  });

  it("workspace cookie pointing outside the user's memberships resolves null", () => {
    expect(resolveWorkspaceId(memberships, { workspaceId: "ws-stranger" })).toBe(null);
    expect(resolveWorkspaceId(memberships, {})).toBe(null);
  });

  it("ambiguous profile binding (two matches) is ignored — falls back", () => {
    const dupes = [
      { workspace_id: "ws-a", zernio_profile_id: "profile-x" },
      { workspace_id: "ws-b", zernio_profile_id: "profile-x" },
    ];
    expect(
      resolveWorkspaceId(dupes, { activeProfileId: "profile-x", workspaceId: "ws-b" }),
    ).toBe("ws-b");
  });

  it("unbound workspaces (null profile) never match a profile cookie", () => {
    const unbound = [{ workspace_id: "ws-a", zernio_profile_id: null }];
    expect(resolveWorkspaceId(unbound, { activeProfileId: "profile-a" })).toBe(null);
  });
});
