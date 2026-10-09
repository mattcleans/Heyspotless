"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppIcon, type AppIconName } from "./app-navigation";
const groups: {
  label: string;
  items: { href: string; label: string; icon: AppIconName }[];
}[] = [
  {
    label: "Run the day",
    items: [
      { href: "/admin", label: "Overview", icon: "home" },
      { href: "/admin/schedule", label: "Schedule", icon: "calendar" },
      { href: "/admin/review", label: "Visit review", icon: "calendar" },
      { href: "/admin/automation", label: "Automation", icon: "sparkle" },
      { href: "/admin/dispatch", label: "Matching", icon: "people" },
      { href: "/admin/cleaner-requests", label: "Cleaner requests", icon: "people" },
      { href: "/admin/cancellations", label: "Cancellations", icon: "calendar" },
      { href: "/admin/inbox", label: "Inbox", icon: "message" },
    ],
  },
  {
    label: "Grow the business",
    items: [
      { href: "/admin/leads", label: "Leads", icon: "sparkle" },
      { href: "/admin/customers", label: "Customers", icon: "people" },
      { href: "/admin/quote", label: "Quotes", icon: "calendar" },
      { href: "/admin/price-book", label: "Pricing", icon: "account" },
      {
        href: "/admin/applications",
        label: "Cleaner applications",
        icon: "people",
      },
      { href: "/admin/reporting", label: "Reports", icon: "calendar" },
    ],
  },
];
export function ManagementNavigation() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);
  return (
    <>
      <button
        ref={toggle}
        className="management-menu-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="management-navigation"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close menu" : "Menu"}
      </button>
      <nav
        id="management-navigation"
        aria-label="Management navigation"
        className={`management-navigation ${open ? "is-open" : ""}`}
      >
        {groups.map((group) => (
          <section key={group.label}>
            <h2>{group.label}</h2>
            <ul>
              {group.items.map((item) => {
                const active =
                  item.href === "/admin"
                    ? pathname === item.href
                    : pathname === item.href ||
                      pathname.startsWith(`${item.href}/`) ||
                      (item.href === "/admin/review" && pathname.startsWith("/admin/visits/"));
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                    >
                      <AppIcon name={item.icon} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <section>
          <h2>View other workspaces</h2>
          <Link href="/customer" onClick={() => setOpen(false)}>
            Customer experience
          </Link>
          <Link href="/cleaner" onClick={() => setOpen(false)}>
            Cleaner experience
          </Link>
        </section>
      </nav>
    </>
  );
}
