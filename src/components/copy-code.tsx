"use client";

import { useEffect, useRef, useState } from "react";

/** Clipboard API where available (secure contexts); otherwise the old hidden-textarea + execCommand route. */
export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused — try the fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/**
 * A record's code (PMA, PMA-M5, PMA-M5-T3) with a button that copies it — for pasting into an agent chat.
 * `bare` renders only the button, for places that already show the code (e.g. inside a TaskLink).
 */
export function CopyCode({ code, bare, className }: { code: string; bare?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async (e: React.MouseEvent) => {
    // Rows and cards may be links; copying must never navigate.
    e.preventDefault();
    e.stopPropagation();
    if (!(await copyText(code))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {!bare && <span className="font-mono">{code}</span>}
      <button
        type="button"
        onClick={onClick}
        aria-label={`Copy ${code}`}
        title={`Copy ${code}`}
        className={`inline-flex shrink-0 items-center rounded p-0.5 hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent ${copied ? "text-ok" : "text-muted hover:text-fg"}`}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
          </svg>
        )}
      </button>
      <span role="status" className={`font-sans text-[11px] text-ok ${copied ? "" : "sr-only"}`}>
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
