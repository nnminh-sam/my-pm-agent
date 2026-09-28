import { fmtDay } from "@/lib/time";
import { Bar, hours } from "./ui";

export interface OutlookData {
  estimate_hours: number;
  estimate_sd_hours: number;
  progress: number;
  projected_finish?: string;
  deadline?: string;
  on_track?: boolean;
  unestimated: number;
}

/** Estimate ± σ, projected finish vs deadline and progress, on one line. */
export function Outlook({ data }: { data: OutlookData }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
      <span title="Expected hours ± one standard deviation">
        {hours(data.estimate_hours)}
        {data.estimate_sd_hours > 0 && ` ±${hours(data.estimate_sd_hours)}`}
        {data.unestimated > 0 && <span className="text-warn"> · {data.unestimated} unestimated</span>}
      </span>
      {(data.projected_finish || data.deadline) && (
        <span className={data.on_track === false ? "text-danger" : ""}>
          {data.projected_finish ? `done ${fmtDay(data.projected_finish)}` : "not scheduled"}
          {data.deadline && ` · due ${fmtDay(data.deadline)}`}
        </span>
      )}
      <span className="flex w-24 items-center gap-2">
        <Bar value={data.progress} tone="ok" />
        {Math.round(data.progress * 100)}%
      </span>
    </div>
  );
}
