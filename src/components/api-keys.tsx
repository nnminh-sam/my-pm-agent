"use client";

import { useActionState, useState, useTransition } from "react";
import { createApiKeyAction, revokeApiKeyAction, type CreateApiKeyState } from "@/app/actions";
import type { PublicApiKey } from "@/lib/auth/api-keys";

/** `YYYY-MM-DD HH:MM UTC`: the same on the server and in the browser (no hydration mismatch). */
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded border border-border px-2 py-1 text-xs hover:bg-bg"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Shown once, right after creation; the key can't be retrieved again (only its hash is stored). */
function NewKey({ id, label, apiKey, endpoint, onDone }: { id: string; label: string; apiKey: string; endpoint: string; onDone: () => void }) {
  const command = `claude mcp add --transport http --scope user my-pm ${endpoint} \\\n  --header "Authorization: Bearer ${apiKey}"`;
  return (
    <div role="status" className="space-y-2 rounded-lg border border-accent bg-accent-soft p-3">
      <p className="font-medium">
        {id}
        {label && ` (${label})`} created. Copy the key now: it won&apos;t be shown again.
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={apiKey}
          aria-label="New API key"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
        />
        <CopyButton text={apiKey} />
      </div>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-bg px-2 py-1.5 font-mono text-xs whitespace-pre">{command}</pre>
        <CopyButton text={command} label="Copy command" />
      </div>
      <button type="button" onClick={onDone} className="text-xs text-muted underline hover:text-fg">
        I&apos;ve saved it
      </button>
    </div>
  );
}

function KeyRow({ apiKey }: { apiKey: PublicApiKey }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const revoked = Boolean(apiKey.revoked_at);
  return (
    <tr className={revoked ? "text-muted" : undefined}>
      <td className="py-1.5 pr-3 font-mono text-xs">{apiKey.id}</td>
      <td className="py-1.5 pr-3">{apiKey.label || <span className="text-muted">—</span>}</td>
      <td className="py-1.5 pr-3 text-xs whitespace-nowrap">{apiKey.created}</td>
      <td className="py-1.5 pr-3 text-xs whitespace-nowrap">{apiKey.last_used_at ? utc(apiKey.last_used_at) : "never"}</td>
      <td className="py-1.5 text-right text-xs whitespace-nowrap">
        {revoked ? (
          `revoked ${apiKey.revoked_at!.slice(0, 10)}`
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Revoke ${apiKey.id}${apiKey.label ? ` (${apiKey.label})` : ""}? Agents using it get 401 right away.`)) return;
              setError(null);
              startTransition(async () => {
                try {
                  await revokeApiKeyAction(apiKey.id);
                } catch {
                  setError("Couldn't revoke it. Reload and try again.");
                }
              });
            }}
            className="rounded border border-border px-2 py-0.5 text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            {pending ? "Revoking…" : "Revoke"}
          </button>
        )}
        {error && <p className="text-danger">{error}</p>}
      </td>
    </tr>
  );
}

export function ApiKeys({ keys, endpoint }: { keys: PublicApiKey[]; endpoint: string }) {
  const [state, create, pending] = useActionState<CreateApiKeyState, FormData>(createApiKeyAction, null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const fresh = state?.ok && state.id !== dismissed ? state : null;

  return (
    <div className="space-y-3">
      <form action={create} className="flex flex-wrap items-center gap-2">
        <input
          name="label"
          maxLength={60}
          placeholder="Label, e.g. claude-code laptop"
          aria-label="Key label"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5"
        />
        <button
          disabled={pending}
          className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50 dark:text-black"
        >
          {pending ? "Creating…" : "Create API key"}
        </button>
      </form>
      {state && !state.ok && (
        <p role="alert" className="text-danger">
          {state.error}
        </p>
      )}
      {fresh && <NewKey id={fresh.id} label={fresh.label} apiKey={fresh.key} endpoint={endpoint} onDone={() => setDismissed(fresh.id)} />}

      {keys.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-1 pr-3 font-normal">Id</th>
                <th className="pb-1 pr-3 font-normal">Label</th>
                <th className="pb-1 pr-3 font-normal">Created</th>
                <th className="pb-1 pr-3 font-normal">Last used</th>
                <th className="pb-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <KeyRow key={k.id} apiKey={k} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted">No API keys yet.</p>
      )}
    </div>
  );
}
