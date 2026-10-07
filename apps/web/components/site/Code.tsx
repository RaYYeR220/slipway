import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import ui from "./ui.module.css";

/** A copyable code block with a one-line title bar. */
export function CodeBlock({ title, code, copy = true }: { title?: string; code: string; copy?: boolean }) {
  return (
    <div className={ui.code}>
      {(title || copy) && (
        <div className={ui.codeBar}>
          <span>{title ?? ""}</span>
          {copy && <CopyButton text={code} />}
        </div>
      )}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The accessible twin of a chart: every plotted value as a table, collapsed by default. */
export function TableView({
  caption,
  head,
  rows,
  numeric = [],
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
  numeric?: number[];
}) {
  return (
    <details className={ui.tableView}>
      <summary>Table view</summary>
      <div className={ui.tableScroll}>
        <table className={ui.table}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={numeric.includes(i) ? ui.num : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static rows, never reordered
              <tr key={i}>
                {r.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static cells
                  <td key={j} className={numeric.includes(j) ? ui.num : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Shown in place of a figure when its data could not be fetched. Never a placeholder value. */
export function Unavailable({ what, url, error }: { what: string; url: string; error: string }) {
  return (
    <p className={ui.unavailable} role="status">
      {what} is unavailable right now ({error}). Source: <code>{url}</code>
    </p>
  );
}
