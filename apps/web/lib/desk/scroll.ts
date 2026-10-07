// Scroll the canvas (its own scroll container on desktop, the window on phones) to a section, without dragging
// the fixed-height page frame along the way scrollIntoView would.
export function scrollToSection(id: string, smooth = true): void {
  const el = document.getElementById(id);
  if (!el) return;
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  const main = document.getElementById("main");
  const own =
    main && getComputedStyle(main).overflowY !== "visible" && main.scrollHeight > main.clientHeight + 1;
  if (main && own) {
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16;
    main.scrollTo({ top, behavior });
  } else {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16, behavior });
  }
}
