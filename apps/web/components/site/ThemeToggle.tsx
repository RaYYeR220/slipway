"use client";

import { useEffect, useState } from "react";
import { THEME_KEY } from "./InlineScript";
import styles from "./site.module.css";

type Mode = "light" | "dark";

function effective(): Mode {
  const a = document.documentElement.getAttribute("data-theme");
  if (a === "light" || a === "dark") return a;
  if (document.querySelector("[data-paper]")) return "light";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    setMode(effective());
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setMode(effective());
    mq.addEventListener("change", sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", sync);
      mo.disconnect();
    };
  }, []);

  const next: Mode = mode === "light" ? "dark" : "light";
  const flip = () => {
    const to = effective() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", to);
    try {
      localStorage.setItem(THEME_KEY, to);
    } catch {
      /* storage blocked: the choice lasts for this page view */
    }
    setMode(to);
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={flip}
      aria-label={mode ? `Switch to ${next} theme` : "Switch theme"}
      title={mode ? `Switch to ${next} theme` : "Switch theme"}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d={mode === "light" ? "M10 3 A7 7 0 0 0 10 17 Z" : "M10 3 A7 7 0 0 1 10 17 Z"}
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
