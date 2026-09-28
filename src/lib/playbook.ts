import { z } from "zod";
import { LIFECYCLE_STAGES, type LifecycleStage } from "./types";

/**
 * Compiled playbooks. A project's playbook, merged with the layers it extends (sdlc, personal, company), is what
 * pm-flow sends from the playbooks repo; a layer compiled on its own has the same shape. my_pm stores every version
 * as sent and never edits one, so a project can be pinned back to any of them. Rule text stays in the playbooks
 * repo: only counts and a hash arrive here. Pure: no I/O.
 */

/** Principle, environment, skill and detector names. */
const NAME = /^[a-z][a-z0-9_-]*$/;
/** `sdlc`, `personal`, or a project code such as `PMA`. */
export const PLAYBOOK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** `<stage>.<name>`, e.g. `spec.accepted`: a check belongs to the stage before the dot. */
export const CHECK_KEY = new RegExp(`^(${LIFECYCLE_STAGES.join("|")})\\.[a-z][a-z0-9_]*$`);

/** What an `auto` check computes from my_pm's own data. */
export const AUTO_RULES = ["tasks_estimated", "tasks_small", "tasks_done", "time_logged", "deployed"] as const;
/** What a `probe` check reads from the signals a repo reports. */
export const PROBE_SIGNALS = ["tests"] as const;

const name = z.string().regex(NAME, "expected lowercase letters, digits, - or _");

const checkFields = {
  principle: name.optional().describe("The principle this check serves."),
  env: name
    .optional()
    .describe("Only for this environment. A release check without one applies to every environment in turn."),
  text: z.string().optional().describe("What passing means. Left out for company projects, which store no check text."),
  task: z
    .object({ estimate: z.number().positive(), title: z.string().min(1).optional() })
    .optional()
    .describe("Entering the stage creates a task with this estimate (hours), so the scheduler plans the work."),
};

export const Check = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto"), rule: z.enum(AUTO_RULES), ...checkFields }),
  z.object({ kind: z.literal("probe"), signal: z.enum(PROBE_SIGNALS), ...checkFields }),
  z.object({ kind: z.literal("attest"), skill: name.optional().describe("The /sdlc skill that records it."), ...checkFields }),
]);
export type Check = z.infer<typeof Check>;

/** Keyed by CHECK_KEY, checked in Playbook's refinement: zod reports a bad record key only as "Invalid key in record". */
const Checks = z.record(z.string(), Check);

export const Environment = z.object({
  name,
  url: z.string().optional(),
  db: z.string().optional(),
  app: z.string().optional(),
});
export type Environment = z.infer<typeof Environment>;

/** Checks and rules that apply once a repo reports that `when` holds (evaluated by pm-flow, in the repo). */
export const Detector = z.object({
  name,
  when: z.object({ exists: z.string().min(1).describe("Path from the repo root; a trailing slash means a directory.") }),
  add: Checks.default({}),
});
export type Detector = z.infer<typeof Detector>;

const DEFAULT_ENVIRONMENTS: Environment[] = [{ name: "dev" }, { name: "staging" }, { name: "prod" }];

export const Playbook = z
  .object({
    name: z.string().regex(PLAYBOOK_NAME, "expected a layer name or project code"),
    version: z.string().regex(VERSION, "expected a version like 1.2.0"),
    /** The layers it was compiled from, base first. Empty for a layer compiled on its own. */
    layers: z
      .array(z.object({ name: z.string().regex(PLAYBOOK_NAME), version: z.string().regex(VERSION) }))
      .default([]),
    /** The software the project builds. */
    software: z.string().optional(),
    principles: z.record(name, z.string()).default({}),
    /** In promotion order. */
    environments: z.array(Environment).min(1).default(DEFAULT_ENVIRONMENTS),
    checks: Checks.default({}),
    detectors: z.array(Detector).default([]),
    /** How many rules the playbook has, and a hash of their text, so a change shows without the text. */
    rules: z
      .object({
        project: z.number().int().nonnegative().default(0),
        layers: z.number().int().nonnegative().default(0),
        hash: z.string().optional(),
      })
      .default({ project: 0, layers: 0 }),
  })
  .superRefine((playbook, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });

    const envs = new Set<string>();
    playbook.environments.forEach((env, i) => {
      if (envs.has(env.name)) issue(["environments", i, "name"], `environment "${env.name}" is listed twice`);
      envs.add(env.name);
    });

    const references = (check: Check, path: (string | number)[]) => {
      if (!CHECK_KEY.test(String(path.at(-1)))) {
        issue(path, "expected <stage>.<name> with a lifecycle stage, e.g. spec.accepted");
      }
      if (check.principle && !(check.principle in playbook.principles)) {
        issue([...path, "principle"], `unknown principle "${check.principle}"`);
      }
      if (check.env && !envs.has(check.env)) issue([...path, "env"], `unknown environment "${check.env}"`);
    };
    for (const [key, check] of Object.entries(playbook.checks)) references(check, ["checks", key]);

    const detectors = new Set<string>();
    const added = new Map<string, string>();
    playbook.detectors.forEach((detector, i) => {
      if (detectors.has(detector.name)) issue(["detectors", i, "name"], `detector "${detector.name}" is listed twice`);
      detectors.add(detector.name);
      for (const [key, check] of Object.entries(detector.add)) {
        const path = ["detectors", i, "add", key];
        if (key in playbook.checks) issue(path, `check "${key}" is already in checks`);
        else if (added.has(key)) issue(path, `check "${key}" is also added by detector "${added.get(key)}"`);
        added.set(key, detector.name);
        references(check, path);
      }
    });
  });
export type Playbook = z.infer<typeof Playbook>;

/** The stage a check belongs to (keys are validated, so the prefix is always a stage). */
export const checkStage = (key: string) => key.slice(0, key.indexOf(".")) as LifecycleStage;

/** How a project pins a version: `PMA@1.2.0`. */
export const playbookRef = ({ name, version }: { name: string; version: string }) => `${name}@${version}`;

export function parsePlaybookRef(ref: string): { name: string; version: string } | undefined {
  const at = ref.lastIndexOf("@");
  const name = ref.slice(0, at);
  const version = ref.slice(at + 1);
  return at > 0 && PLAYBOOK_NAME.test(name) && VERSION.test(version) ? { name, version } : undefined;
}
