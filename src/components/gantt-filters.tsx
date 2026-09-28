"use client";

import { useRef } from "react";
import type { Unit } from "@/lib/timescale";

/** Options are chosen by code, which is also what lands in the URL (`?project=PMA&milestone=PMA-M1`). */
interface Option {
  code: string;
  title: string;
}

/**
 * Filters as a plain GET form, so the URL is the only state: reloads, bookmarks and shared links
 * all restore the view. Changing any field submits immediately.
 */
export function GanttFilters(props: {
  projects: Option[];
  milestones: Option[];
  selected: { projects: string[]; milestones: string[]; from?: string; to?: string };
  unit: Unit;
}) {
  const { projects, milestones, selected, unit } = props;
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  // The fields are uncontrolled, so reset the DOM itself and let the resulting submit rewrite the URL.
  const clear = () => {
    form.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((c) => (c.checked = false));
    form.current?.querySelectorAll<HTMLInputElement>("input[type=date]").forEach((d) => (d.value = ""));
    submit();
  };
  const active = selected.projects.length + selected.milestones.length > 0 || selected.from || selected.to;
  const input = "rounded border border-border bg-surface px-2 py-1 text-sm [color-scheme:light_dark]";

  return (
    <form ref={form} action="/gantt" method="get" className="flex flex-wrap items-end gap-3 text-sm">
      <input type="hidden" name="unit" value={unit} />
      <Multi label="Projects" name="project" options={projects} selected={selected.projects} onChange={submit} />
      <Multi label="Milestones" name="milestone" options={milestones} selected={selected.milestones} onChange={submit} />
      <label className="flex flex-col gap-0.5 text-xs text-muted">
        From
        <input type="date" name="from" defaultValue={selected.from} onChange={submit} className={input} />
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-muted">
        To
        <input type="date" name="to" defaultValue={selected.to} onChange={submit} className={input} />
      </label>
      <noscript>
        <button className={input}>Apply</button>
      </noscript>
      {active && (
        <button type="button" onClick={clear} className="pb-1 text-sm text-accent hover:underline">
          Clear filters
        </button>
      )}
    </form>
  );
}

function Multi(props: { label: string; name: string; options: Option[]; selected: string[]; onChange: () => void }) {
  const { label, name, options, selected, onChange } = props;
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none flex-col gap-0.5 text-xs text-muted">
        {label}
        <span className="rounded border border-border bg-surface px-2 py-1 text-sm text-fg">
          {selected.length ? `${selected.length} selected` : "All"} ▾
        </span>
      </summary>
      <div className="absolute z-30 mt-1 max-h-64 min-w-56 max-w-[calc(100vw-2rem)] overflow-auto rounded border border-border bg-surface p-1 shadow-lg">
        {options.length ? (
          options.map((o) => (
            <label key={o.code} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-bg">
              <input type="checkbox" name={name} value={o.code} defaultChecked={selected.includes(o.code)} onChange={onChange} />
              <span className="font-mono text-xs text-muted">{o.code}</span>
              <span className="truncate">{o.title}</span>
            </label>
          ))
        ) : (
          <p className="px-2 py-1 text-muted">Nothing to choose</p>
        )}
      </div>
    </details>
  );
}
