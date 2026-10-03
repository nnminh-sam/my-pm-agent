import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Priority, TaskStatus } from "@/lib/types";

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

export function Badge({ children, tone = "neutral", title }: { children: React.ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", TONES[tone])}
    >
      {children}
    </span>
  );
}

type Tone = "neutral" | "accent" | "danger" | "warn" | "ok" | "muted";
const TONES: Record<Tone, string> = {
  neutral: "bg-bg text-fg border border-border",
  accent: "bg-accent-soft text-accent",
  danger: "bg-danger-soft text-danger",
  warn: "bg-warn-soft text-warn",
  ok: "bg-ok-soft text-ok",
  muted: "text-muted border border-border",
};

const PRIORITY_TONE: Record<Priority, Tone> = { P0: "danger", P1: "warn", P2: "neutral", P3: "muted" };
export function PriorityBadge({ priority, inherited }: { priority: Priority; inherited?: boolean }) {
  return (
    <span className={inherited ? "opacity-60" : undefined}>
      <Badge tone={PRIORITY_TONE[priority]} title={inherited ? "Inherited from the milestone" : undefined}>
        {priority}
      </Badge>
    </span>
  );
}

const STATUS_TONE: Record<TaskStatus, Tone> = {
  todo: "neutral",
  in_progress: "accent",
  blocked: "danger",
  done: "ok",
  cancelled: "muted",
};
export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status.replace("_", " ")}</Badge>;
}

export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "warn" | "ok" }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-lg font-semibold tabular-nums",
          tone === "danger" && "text-danger",
          tone === "warn" && "text-warn",
          tone === "ok" && "text-ok",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function Bar({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" | "warn" }) {
  const color = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn" }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div className={cx("h-full rounded-full", color)} style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cx("rounded-xl border border-border bg-surface", className)}>{children}</section>;
}

export function Notice({ tone, title, items }: { tone: "danger" | "warn"; title: string; items: React.ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className={cx("rounded-xl px-4 py-3 text-sm", tone === "danger" ? "bg-danger-soft" : "bg-warn-soft")}>
      <div className={cx("font-medium", tone === "danger" ? "text-danger" : "text-warn")}>{title}</div>
      <ul className="mt-1 space-y-0.5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function TaskLink({ code, title, wrap }: { code: string; title?: string; wrap?: boolean }) {
  return (
    <Link href={`/tasks/${code}`} className="group inline-flex max-w-full min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-xs whitespace-nowrap text-muted">{code}</span>
      {title && <span className={cx("min-w-0 group-hover:underline", !wrap && "truncate")}>{title}</span>}
    </Link>
  );
}

export function Markdown({ children }: { children: string }) {
  if (!children.trim()) return <p className="text-sm text-muted italic">No description.</p>;
  return (
    <div className="md text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

export const hours = (h?: number) => (h === undefined ? "—" : `${Math.round(h * 100) / 100}h`);

export { NavigationProgress, PageSkeleton, PendingButton, PendingStatus, Spinner, SubmitButton } from "./pending";
