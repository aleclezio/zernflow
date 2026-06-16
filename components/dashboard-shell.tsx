"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { withBasePath } from "@/lib/client-url";
import { cn } from "@/lib/utils";
import type { Database } from "@/lib/types/database";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

interface WorkspaceItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Responsive shell for the dashboard. On md+ the sidebar sits in-flow exactly
 * as before. On phones it becomes an off-canvas drawer (hamburger in a slim top
 * bar slides it in over a scrim), so the 240px rail no longer eats ~64% of the
 * screen. The drawer auto-closes on navigation (pathname change).
 */
export function DashboardShell({
  workspace,
  user,
  workspaces,
  children,
}: {
  workspace: Workspace;
  user: { id: string; email?: string };
  workspaces: WorkspaceItem[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A nav tap on mobile changes the route — close the drawer behind it.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar — in-flow */}
      <div className="hidden md:flex">
        <Sidebar workspace={workspace} user={user} workspaces={workspaces} />
      </div>

      {/* Mobile drawer + scrim */}
      <div
        className={cn("fixed inset-0 z-50 md:hidden", open ? "" : "pointer-events-none")}
        aria-hidden={!open}
      >
        <div
          onClick={() => setOpen(false)}
          className={cn(
            "absolute inset-0 bg-black/40 transition-opacity",
            open ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-transform duration-200",
            open ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <Sidebar workspace={workspace} user={user} workspaces={workspaces} />
        </div>
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with hamburger */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation menu"
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- repo basePath idiom (see sidebar.tsx) */}
          <img src={withBasePath("/lygge-mark.png")} alt="lygge" width={24} height={16} className="dark:invert" />
          <span className="text-sm font-medium text-sidebar-foreground/80">Engage</span>
        </div>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
