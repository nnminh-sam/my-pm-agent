import { cookies, headers } from "next/headers";
import { ApiKeys } from "@/components/api-keys";
import { Card } from "@/components/ui";
import { SESSION_COOKIE, authMode, authenticate } from "@/lib/auth";
import { toPublicApiKey } from "@/lib/auth/api-keys";
import { getSettings, listUserApiKeys } from "@/lib/repo";
import { getRepository } from "@/lib/repository";
import { WEEKDAYS } from "@/lib/types";

export const dynamic = "force-dynamic";

const PROMPTS = [
  ["breakdown_project", "Turn a project goal into milestones with specs, then break each one down."],
  ["breakdown_milestone", "Turn a milestone spec into small, estimated, dependency-linked tasks."],
  ["estimate_tasks", "Three-point estimates for unestimated tasks, calibrated on your history."],
  ["replan", "Diagnose the schedule and propose a rearrangement."],
  ["daily_checkin", "Log what you did and see today's plan."],
];

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre">{children}</pre>
  );
}

const STORAGE_LABELS = {
  postgres: "Neon Postgres",
  fs: "Local markdown files",
};

export default async function ConnectPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;
  // With accounts on, agents authenticate with an API key created below (or npm run auth:create-key).
  const mode = authMode();
  const secured = mode === "jwt";
  const session = secured ? authenticate({ sessionCookie: (await cookies()).get(SESSION_COOKIE)?.value }) : null;
  const userId = session && session !== "agent" ? session.sub : null;
  // The hash never leaves the server.
  const keys = userId ? (await listUserApiKeys(userId)).map(toPublicApiKey).reverse() : [];
  const settings = await getSettings();
  const storage = getRepository().kind;

  const claudeCmd = `claude mcp add --transport http --scope user my-pm ${endpoint}${
    secured ? ` \\\n  --header "Authorization: Bearer $PM_API_KEY"` : ""
  }`;
  const json = JSON.stringify(
    { mcpServers: { "my-pm": { type: "http", url: endpoint, ...(secured && { headers: { Authorization: "Bearer <API_KEY>" } }) } } },
    null,
    2,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Connect an agent</h1>

      {userId && (
        <Card className="space-y-3 px-5 py-4 text-sm">
          <div>
            <h2 className="font-medium">API keys</h2>
            <p className="text-muted">
              Agents send one as <code className="font-mono text-xs">Authorization: Bearer &lt;key&gt;</code>. A key is
              shown once when it&apos;s created; only its hash is stored, so a lost key can&apos;t be recovered: revoke it
              and create another.
            </p>
          </div>
          <ApiKeys keys={keys} endpoint={endpoint} />
        </Card>
      )}

      <Card className="space-y-3 px-5 py-4 text-sm">
        <h2 className="font-medium">Claude Code</h2>
        <Code>{claudeCmd}</Code>
        <p className="text-muted">
          Then ask things like “create a project for the website relaunch and plan it”, or run a prompt:{" "}
          <code className="font-mono text-xs">/mcp__my-pm__breakdown_project PMA</code>.
        </p>
        {mode === "open" && (
          <p className="text-warn">
            No JWT_SECRET is set, so auth is off and the endpoint is open. That&apos;s fine on localhost; deployments stay
            locked until you set one.
          </p>
        )}
        {secured && (
          <p className="text-muted">
            Use an API key from above as <code className="font-mono text-xs">$PM_API_KEY</code>. On a 401 the key is
            wrong or revoked: create a new one, update the header and reconnect (
            <code className="font-mono text-xs">/mcp</code>).
          </p>
        )}
      </Card>

      <Card className="space-y-3 px-5 py-4 text-sm">
        <h2 className="font-medium">Other MCP clients (Cursor, Windsurf, VS Code…)</h2>
        <Code>{json}</Code>
        <p className="text-muted">
          In-browser agents also get the read and update tools on these pages through WebMCP, when the browser supports it.
        </p>
      </Card>

      <Card className="px-5 py-4 text-sm">
        <h2 className="mb-2 font-medium">Prompts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {PROMPTS.map(([name, desc]) => (
            <div key={name} className="contents">
              <dt className="font-mono text-xs leading-5">{name}</dt>
              <dd className="text-muted">{desc}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="px-5 py-4 text-sm">
        <h2 className="mb-2 font-medium">Scheduling settings</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted">Timezone</dt>
          <dd>{settings.timezone}</dd>
          {WEEKDAYS.map((d) => (
            <div key={d} className="contents">
              <dt className="text-muted capitalize">{d}</dt>
              <dd className="font-mono text-xs leading-5">{settings.work_hours[d]?.join(", ") || "off"}</dd>
            </div>
          ))}
          <dt className="text-muted">Estimate buffer</dt>
          <dd>×{settings.buffer}</dd>
          <dt className="text-muted">Task size limit</dt>
          <dd>{settings.max_task_hours}h</dd>
          <dt className="text-muted">Storage</dt>
          <dd>{STORAGE_LABELS[storage]}</dd>
        </dl>
        <p className="mt-3 text-muted">
          Change these with the <code className="font-mono text-xs">update_settings</code> tool, or edit{" "}
          <code className="font-mono text-xs">settings.yaml</code>.
        </p>
      </Card>
    </div>
  );
}
