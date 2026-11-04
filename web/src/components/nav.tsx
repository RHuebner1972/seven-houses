"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export const NAV_LINKS = [
  { label: "Today", href: "/" },
  { label: "Chart", href: "/chart/" },
  { label: "Reading", href: "/reading/new/" },
  { label: "Journal", href: "/journal/" },
  { label: "Store", href: "/store/" },
  { label: "Account", href: "/account/" },
] as const;

function isCurrent(pathname: string | null, href: string) {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href.replace(/\/new\/$/, "/"));
}

export function Nav({ right }: { right?: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex items-center border-t border-gold/30 bg-bg-deep/95 backdrop-blur md:static md:border-t-0 md:border-b md:px-6"
    >
      <span className="hidden font-display text-xl text-gold-hi md:block md:mr-8">
        Seventh House
      </span>
      <ul className="flex flex-1 justify-around md:flex-none md:justify-start md:gap-6">
        {NAV_LINKS.map(({ label, href }) => {
          const current = isCurrent(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`block px-2 py-3 text-sm md:py-4 ${
                  current ? "text-gold-hi border-t-2 border-gold md:border-t-0 md:border-b-2" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      {right ? <div className="ml-auto shrink-0 px-2 md:px-0">{right}</div> : null}
    </nav>
  );
}
