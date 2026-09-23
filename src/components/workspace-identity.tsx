import Link from "next/link";
import { getRepository } from "@/lib/data";

const labels = { admin: "Manager", customer: "Customer", cleaner: "Cleaner" };
/** The signed-in role is distinct from the screen a manager is previewing. */
export async function WorkspaceIdentity({
  area,
}: {
  area: "admin" | "customer" | "cleaner";
}) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  return (
    <div className="workspace-identity">
      <div>
        <span className="workspace-role">
          {repo.isDemo
            ? "Preview"
            : profile
              ? labels[profile.role]
              : "Not signed in"}
        </span>
        <span className="workspace-person">
          {profile?.fullName ??
            (repo.isDemo ? "Sample workspace" : "Hey Spotless")}
        </span>
      </div>
      {profile?.role === "admin" && area !== "admin" ? (
        <Link href="/admin" className="workspace-return">
          Return to Management
        </Link>
      ) : (
        <span className="workspace-area">{labels[area]} workspace</span>
      )}
    </div>
  );
}
