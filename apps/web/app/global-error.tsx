"use client";
// Safety net for a failure in the root layout itself: its own document on the site's tokens, a retry and the way home.
import "./globals.css";

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <title>Slipway is unavailable</title>
        <main style={{ maxWidth: "36em", margin: "0 auto", padding: "var(--s-9) var(--s-4)" }}>
          <h1 style={{ margin: 0, font: "300 44px / 1 var(--f-display)", letterSpacing: "-0.025em" }}>
            Slipway is unavailable
          </h1>
          <p style={{ color: "var(--muted)", fontSize: 18 }}>
            Something failed before the page could be drawn. Nothing is filled in to cover for it.
          </p>
          <p style={{ display: "flex", gap: "var(--s-5)", alignItems: "center" }}>
            <button
              type="button"
              onClick={retry}
              style={{
                border: 0,
                borderRadius: "var(--r)",
                padding: "15px 22px",
                background: "var(--t-8)",
                color: "var(--ab-950)",
                font: "600 15.5px / 1 var(--f-body)",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a href="/" style={{ textUnderlineOffset: 4 }}>
              Back to Slipway
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
