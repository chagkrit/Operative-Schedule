"use client";

import type { MouseEvent, ReactNode } from "react";
import { TAB_IDS, formatBadge, tabHref, type TabId } from "./lib/nav";

const TABS: Record<TabId, { label: string; icon: ReactNode }> = {
  schedule: {
    label: "ตาราง",
    icon: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
        <path d="M8 3v4M16 3v4M3.5 10h17" />
      </>
    ),
  },
  book: {
    label: "ลงคิว",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </>
    ),
  },
  search: {
    label: "ค้นหา",
    icon: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
  },
  alerts: {
    label: "แจ้งเตือน",
    icon: (
      <>
        <path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15z" />
        <path d="M10 21a2 2 0 0 0 4 0" />
      </>
    ),
  },
};

type BottomNavProps = {
  active: TabId;
  unseenAlerts: number;
  onSelect: (tab: TabId) => void;
};

export default function BottomNav({ active, unseenAlerts, onSelect }: BottomNavProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>, tab: TabId) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(tab);
  }

  return (
    <nav className="bottom-nav" aria-label="เมนูหลัก">
      {TAB_IDS.map((tab) => {
        const { label, icon } = TABS[tab];
        const isActive = tab === active;
        const badge = tab === "alerts" ? formatBadge(unseenAlerts) : "";
        return (
          <a
            key={tab}
            href={tabHref(tab)}
            className="bottom-nav-link"
            aria-current={isActive ? "page" : undefined}
            aria-label={badge ? `${label} ยังไม่ได้ดู ${unseenAlerts} รายการ` : undefined}
            onClick={(event) => handleClick(event, tab)}
          >
            <span className="bottom-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">{icon}</svg>
              {badge && <span className="bottom-nav-badge">{badge}</span>}
            </span>
            <span className="bottom-nav-label">{label}</span>
          </a>
        );
      })}
    </nav>
  );
}
