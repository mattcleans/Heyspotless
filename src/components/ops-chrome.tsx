import Link from "next/link";
import type { ReactNode } from "react";
import { isDemoMode } from "@/lib/supabase/env";
import { ManagementNavigation } from "./management-navigation";
import { WorkspaceIdentity } from "./workspace-identity";
import { AppIcon } from "./app-navigation";
export function OpsChrome({ children }: { children: ReactNode }) {
  return (
    <div className="management-app">
      <a className="skip-link" href="#management-content">
        Skip to content
      </a>
      <header className="management-header">
        <Link href="/admin" className="brand-lockup">
          <span className="brand-mark">
            <AppIcon name="sparkle" />
          </span>
          Hey Spotless
        </Link>
        <span className="management-label">Management</span>
      </header>
      <ManagementNavigation />
      <div className="management-body">
        <WorkspaceIdentity area="admin" />
        {isDemoMode() && (
          <div className="preview-note">
            Preview only. Sample records, with no live messages or charges.
          </div>
        )}
        <main id="management-content">{children}</main>
      </div>
    </div>
  );
}
