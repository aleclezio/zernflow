"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { setZernioKey, setAiKey } from "@/lib/workspace-keys";
import { isValidAutoAssignMode } from "@/lib/auto-assign";
import { WORKSPACE_COOKIE, PROFILE_COOKIE } from "@/lib/workspace";

/**
 * Update workspace settings. API keys are owner-only and stored encrypted
 * (AES-256-GCM, AAD = workspace id) — they must never be written from the
 * browser client.
 */
export async function updateWorkspaceSettings(
  workspaceId: string,
  updates: {
    name?: string;
    globalKeywords?: string[];
    apiKey?: string;
    aiKey?: string;
    aiIntentEnabled?: boolean;
    autoAssignMode?: string;
  }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return { error: "No access to this workspace" };

  const apiKey = updates.apiKey?.trim();
  const aiKey = updates.aiKey?.trim();
  if ((apiKey || aiKey) && membership.role !== "owner") {
    return { error: "Only the workspace owner can manage API keys" };
  }

  const base: Record<string, unknown> = {};
  if (updates.name?.trim()) base.name = updates.name.trim();
  if (updates.globalKeywords) base.global_keywords = updates.globalKeywords;
  // Use an explicit undefined check so toggling the feature OFF (false) persists.
  if (updates.aiIntentEnabled !== undefined) base.ai_intent_enabled = updates.aiIntentEnabled;
  if (updates.autoAssignMode !== undefined) {
    if (!isValidAutoAssignMode(updates.autoAssignMode)) {
      return { error: "Invalid auto-assign mode" };
    }
    base.auto_assign_mode = updates.autoAssignMode;
  }
  if (Object.keys(base).length > 0) {
    const { error } = await supabase
      .from("workspaces")
      .update(base)
      .eq("id", workspaceId)
      .select("id")
      .single();
    if (error) return { error: error.message };
  }

  if (apiKey) {
    const { error } = await setZernioKey(supabase, workspaceId, apiKey);
    if (error) return { error: "Failed to save API key" };
  }
  if (aiKey) {
    const { error } = await setAiKey(supabase, workspaceId, aiKey);
    if (error) return { error: "Failed to save AI key" };
  }

  return { ok: true };
}

export async function switchWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  // Validate access + pull the workspace's Zernio profile binding (to keep the
  // shared active_profile_id cookie in sync).
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(zernio_profile_id)")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .single();

  if (!membership) return { error: "No access to this workspace" };

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });

  // Keep active_profile_id (the cookie the command-centre client switcher writes
  // and resolveWorkspaceId prioritises) consistent, so the unified shell never
  // disagrees about which account is active. Bound profile -> set it; unbound ->
  // clear so resolution falls back to the workspace cookie just set.
  const profileId =
    (membership.workspaces as { zernio_profile_id: string | null } | null)?.zernio_profile_id ?? null;
  if (profileId) {
    cookieStore.set(PROFILE_COOKIE, profileId, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    cookieStore.set(PROFILE_COOKIE, "", { path: "/", maxAge: 0 });
  }

  return { ok: true };
}

export async function createWorkspace(name: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required" };

  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .insert({ name: trimmed, slug })
    .select("id")
    .single();

  if (error || !workspace) {
    return { error: error?.message || "Failed to create workspace" };
  }

  // Add user as owner
  await supabase.from("workspace_members").insert({
    workspace_id: workspace.id,
    user_id: user.id,
    role: "owner",
  });

  // Switch to new workspace
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspace.id, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
  // A new workspace has no Zernio profile yet — clear the shared profile cookie
  // so resolution uses the workspace cookie (else a stale active_profile_id from
  // another workspace would win and hide the new one).
  cookieStore.set(PROFILE_COOKIE, "", { path: "/", maxAge: 0 });

  return { ok: true, workspaceId: workspace.id };
}
