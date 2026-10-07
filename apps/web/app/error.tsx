"use client";
// Route error boundary: a page that throws says so plainly and offers a retry, never a blank screen.
import Link from "next/link";
import { useEffect } from "react";
import { Header } from "@/components/site/Header";
import ui from "@/components/site/ui.module.css";

export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      <Header />
      <main id="main" className={ui.page}>
        <section className={ui.section}>
          <h1 className={ui.h1}>This page is unavailable</h1>
          <p className={ui.lede}>
            Something it reads failed or came back in a shape it does not expect, and nothing is filled in to
            cover for it.
            {error.digest ? (
              <>
                {" "}
                Reference <code>{error.digest}</code>.
              </>
            ) : null}
          </p>
          <p
            className={ui.lede}
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s-5)" }}
          >
            <button type="button" className={ui.cta} style={{ border: 0, cursor: "pointer" }} onClick={retry}>
              Try again
            </button>
            <Link className={ui.textLink} href="/">
              Back to Slipway
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}
