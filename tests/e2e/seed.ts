// Seeds the e2e workspace (file backend in PM_DATA_DIR) through the repository, before the server starts.
// Run by playwright.config.ts's webServer: node --import tsx tests/e2e/seed.ts
import { addComment, createMilestone, createProject, createTasks } from "../../src/lib/repo";
import { signUp } from "../../src/lib/auth/users";
import { issueApiKey } from "../../src/lib/auth/api-keys";
import { E2E_USER } from "./fixtures";

async function main() {
  if (process.env.PM_STORAGE !== "fs" || !process.env.PM_DATA_DIR) throw new Error("seed.ts only seeds a file workspace in PM_DATA_DIR");
  // Company projects never contact GitHub, so no page open reaches the network.
  await createProject({ title: "E2E project", code: "E2E", context: "company", repos: ["e2e/app", "e2e/web"] });
  await createMilestone({ title: "E2E milestone", project: "E2E" });
  await createTasks([
    { title: "First task", milestone: "E2E-M1", estimate: 4 },
    { title: "Second task", milestone: "E2E-M1", estimate: 2 },
  ]);
  for (const body of ["comment one", "comment two", "comment three"]) await addComment("E2E-M1-T1", body, "you");
  const outcome = await signUp({ email: E2E_USER.email, password: E2E_USER.password, confirm: E2E_USER.password });
  if (!outcome.ok) throw new Error(`seed sign-up failed: ${JSON.stringify(outcome)}`);
  await issueApiKey({ label: "e2e one", userId: outcome.user.id });
  await issueApiKey({ label: "e2e two", userId: outcome.user.id });
  console.log(`Seeded ${process.env.PM_DATA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
