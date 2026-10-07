"use client";

import { useEffect, useState } from "react";
import { CodeBlock } from "../site/Code";

const PLACEHOLDER = "https://<your-slipway-host>";

/** A code block whose `{ORIGIN}` placeholders become this deployment's origin once the page is in a browser. */
export function OriginCode({ title, code }: { title: string; code: string }) {
  const [origin, setOrigin] = useState(PLACEHOLDER);
  useEffect(() => setOrigin(window.location.origin), []);
  return <CodeBlock title={title} code={code.replaceAll("{ORIGIN}", origin)} />;
}
