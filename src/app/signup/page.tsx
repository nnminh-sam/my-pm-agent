import Link from "next/link";
import { signUp } from "@/app/actions";
import { AuthCard, ErrorMessage, Field, ModeNotice, SubmitButton } from "@/components/auth-form";
import { authMode, safeNext } from "@/lib/auth";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { signupStatus } from "@/lib/auth/users";

export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const mode = authMode();
  const back = safeNext(next);
  const status = mode === "jwt" ? await signupStatus() : null;
  const loginLink = (
    <Link href={`/login?next=${encodeURIComponent(back)}`} className="text-accent underline">
      Log in
    </Link>
  );

  return (
    <AuthCard title="Create an account">
      {mode !== "jwt" ? (
        <ModeNotice mode={mode} />
      ) : status === "closed" ? (
        <p className="mt-3 text-sm text-muted">
          Sign-up is closed: this workspace already has an account. Ask the owner to add your email to PM_SIGNUP_EMAILS, or{" "}
          {loginLink}.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">
            {status === "open"
              ? "Create the first account for this workspace."
              : "Sign-up is limited to invited emails (PM_SIGNUP_EMAILS)."}
          </p>
          <form action={signUp} className="mt-4 space-y-3">
            <input type="hidden" name="next" value={back} />
            <Field name="email" label="Email" type="email" required autoFocus autoComplete="email" />
            <Field
              name="password"
              label={`Password (${MIN_PASSWORD_LENGTH}+ characters)`}
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              autoComplete="new-password"
            />
            <Field name="confirm" label="Confirm password" type="password" required autoComplete="new-password" />
            <ErrorMessage code={error} />
            <SubmitButton>Sign up</SubmitButton>
          </form>
          <p className="mt-4 text-sm text-muted">Already have an account? {loginLink}</p>
        </>
      )}
    </AuthCard>
  );
}
