import type { ReactNode } from "react";
import { OpsChrome } from "@/components/ops-chrome";

/** Staff area: the nav bar with every internal surface on it. */
export default function CleanerLayout({ children }: { children: ReactNode }) {
  return <OpsChrome>{children}</OpsChrome>;
}
