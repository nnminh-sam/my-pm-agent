import { createMcpHandler } from "mcp-handler";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, isAuthorized } from "@/lib/auth";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/prompts";
import { registerPmServer } from "@/lib/mcp/server";

const mcp = createMcpHandler(registerPmServer, {
  serverInfo: { name: "my-pm", version: "0.1.0" },
  instructions: SERVER_INSTRUCTIONS,
  // Tools exposed to in-browser agents on the web UI via WebMCP (see layout.tsx).
  experimental_webMcp: {
    tools: [
      "get_overview",
      "get_schedule",
      "list_projects",
      "get_project",
      "list_tasks",
      "get_task",
      "list_milestones",
      "get_milestone",
      "get_estimation_stats",
      "get_next",
      "get_lifecycle",
      "update_task",
      "log_time",
    ],
  },
});

// proxy.ts already checks auth; this guards the endpoint if the matcher ever changes. With an API key this
// is a second lookup (the proxy can't hand its result on); verifyApiKey throttles the last_used_at write.
async function handler(request: NextRequest) {
  const credentials = {
    authorization: request.headers.get("authorization"),
    sessionCookie: request.cookies.get(SESSION_COOKIE)?.value,
  };
  if (!(await isAuthorized(credentials))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="pm"' } });
  }
  return mcp(request);
}

export { handler as GET, handler as POST, handler as DELETE };
export const dynamic = "force-dynamic";
