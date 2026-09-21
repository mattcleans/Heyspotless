"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type AppIconName =
  "home" | "people" | "calendar" | "account" | "sparkle" | "message";
const paths: Record<AppIconName, string> = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  people:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7a4 4 0 0 1 0 8",
  calendar:
    "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m2 10h3m4 0h3m-10 4h3",
  account: "M20 21v-2a7 7 0 0 0-14 0v2M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  sparkle:
    "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4",
  message:
    "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0ZM7 10h10M7 14h6",
};
export function AppIcon({ name }: { name: AppIconName }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function AppNavigation({
  tabs,
  label,
}: {
  tabs: { href: string; label: string; icon: AppIconName }[];
  label: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="app-tabs">
      <ul>
        {tabs.map((tab, index) => {
          const active =
            index === 0
              ? pathname === tab.href
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link href={tab.href} aria-current={active ? "page" : undefined}>
                <AppIcon name={tab.icon} />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
