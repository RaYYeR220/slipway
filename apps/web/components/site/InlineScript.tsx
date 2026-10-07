/** Runs once, synchronously, on a full page load (React does not execute it on client navigations). */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static first-party script, no interpolated input
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const THEME_KEY = "slipway-theme";

/** Applies the reader's stored theme before first paint. Belongs in <head> of app/layout.tsx once the lead moves it. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
