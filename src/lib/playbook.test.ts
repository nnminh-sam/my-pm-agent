import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { Playbook, checkStage, parsePlaybookRef, playbookRef } from "./playbook";
import { LIFECYCLE_STAGES } from "./types";

const seed = () => YAML.parse(readFileSync(new URL("./playbooks/sdlc.yaml", import.meta.url), "utf8"));

/** The problems zod reports, as `path: message` lines. */
function problems(input: unknown): string[] {
  const result = Playbook.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

const minimal = { name: "PMA", version: "1.0.0" };

describe("the seed sdlc playbook", () => {
  const sdlc = Playbook.parse(seed());

  it("parses, with a check for every stage but idea", () => {
    expect(sdlc.name).toBe("sdlc");
    expect(sdlc.version).toBe("1.0.0");
    expect(sdlc.environments.map((e) => e.name)).toEqual(["dev", "staging", "prod"]);
    const stages = new Set(Object.keys(sdlc.checks).map(checkStage));
    expect(LIFECYCLE_STAGES.filter((s) => !stages.has(s))).toEqual(["idea"]);
  });

  it("gives each check kind what it needs", () => {
    expect(sdlc.checks["plan.estimated"]).toMatchObject({ kind: "auto", rule: "tasks_estimated" });
    expect(sdlc.checks["verify.tests"]).toMatchObject({ kind: "probe", signal: "tests" });
    expect(sdlc.checks["verify.review"]).toMatchObject({ kind: "attest", skill: "verify", task: { estimate: 0.5 } });
    expect(sdlc.checks["release.rollback_plan"]).toMatchObject({ env: "prod", principle: "reversible" });
  });

  it("adds the migration check through a detector", () => {
    expect(sdlc.detectors).toHaveLength(1);
    expect(sdlc.detectors[0]).toMatchObject({ name: "migrations", when: { exists: "migrations/" } });
    expect(sdlc.detectors[0].add["release.migration_paired"]).toMatchObject({ kind: "attest", env: "prod" });
    expect(sdlc.checks["release.migration_paired"]).toBeUndefined();
  });
});

describe("Playbook", () => {
  it("fills in defaults", () => {
    expect(Playbook.parse(minimal)).toEqual({
      ...minimal,
      layers: [],
      principles: {},
      environments: [{ name: "dev" }, { name: "staging" }, { name: "prod" }],
      checks: {},
      detectors: [],
      rules: { project: 0, layers: 0 },
    });
  });

  it("keeps the layers a project playbook was compiled from", () => {
    const pma = Playbook.parse({
      ...minimal,
      layers: [
        { name: "sdlc", version: "1.0.0" },
        { name: "personal", version: "1.0.0" },
      ],
      environments: [{ name: "dev", app: "localhost:3000" }, { name: "prod" }],
      rules: { project: 2, layers: 9, hash: "abc" },
    });
    expect(pma.layers.map(playbookRef)).toEqual(["sdlc@1.0.0", "personal@1.0.0"]);
    expect(pma.rules).toEqual({ project: 2, layers: 9, hash: "abc" });
  });

  it("rejects bad names and versions", () => {
    expect(problems({ name: "my playbook", version: "1.0.0" })).toEqual(["name: expected a layer name or project code"]);
    for (const version of ["1.0", "v1.0.0", "01.0.0", "1.0.0-beta"]) {
      expect(problems({ name: "sdlc", version })).toEqual(["version: expected a version like 1.2.0"]);
    }
  });

  it("rejects check keys that aren't <stage>.<name>", () => {
    for (const key of ["deploy.done", "spec", "spec.Accepted", "spec.accepted.extra", "done.retro"]) {
      expect(problems({ ...minimal, checks: { [key]: { kind: "attest" } } })).toEqual([
        `checks.${key}: expected <stage>.<name> with a lifecycle stage, e.g. spec.accepted`,
      ]);
    }
  });

  it("rejects checks missing what their kind needs", () => {
    expect(problems({ ...minimal, checks: { "plan.estimated": { kind: "auto" } } })).toHaveLength(1);
    expect(problems({ ...minimal, checks: { "verify.tests": { kind: "probe", signal: "lint" } } })).toHaveLength(1);
    expect(problems({ ...minimal, checks: { "verify.tests": { kind: "guess" } } })).toHaveLength(1);
    expect(problems({ ...minimal, checks: { "verify.review": { kind: "attest", task: { estimate: 0 } } } })).toHaveLength(1);
  });

  it("rejects unknown principles and environments", () => {
    expect(
      problems({
        ...minimal,
        principles: { verified: "Nothing ships unverified" },
        environments: [{ name: "dev" }, { name: "live" }],
        checks: {
          "verify.review": { kind: "attest", principle: "speed" },
          "release.rollback_plan": { kind: "attest", env: "prod" },
        },
        detectors: [
          { name: "docker", when: { exists: "Dockerfile" }, add: { "release.image_pushed": { kind: "attest", env: "staging" } } },
        ],
      }),
    ).toEqual([
      'checks.verify.review.principle: unknown principle "speed"',
      'checks.release.rollback_plan.env: unknown environment "prod"',
      'detectors.0.add.release.image_pushed.env: unknown environment "staging"',
    ]);
  });

  it("rejects duplicate environments and detectors, and detector checks that clash", () => {
    expect(
      problems({
        ...minimal,
        environments: [{ name: "dev" }, { name: "dev" }],
        checks: { "release.deployed": { kind: "auto", rule: "deployed" } },
        detectors: [
          { name: "migrations", when: { exists: "migrations/" }, add: { "release.deployed": { kind: "attest" } } },
          { name: "migrations", when: { exists: "db/" }, add: { "release.migration_paired": { kind: "attest" } } },
          { name: "prisma", when: { exists: "prisma/" }, add: { "release.migration_paired": { kind: "attest" } } },
        ],
      }),
    ).toEqual([
      'environments.1.name: environment "dev" is listed twice',
      'detectors.0.add.release.deployed: check "release.deployed" is already in checks',
      'detectors.1.name: detector "migrations" is listed twice',
      'detectors.2.add.release.migration_paired: check "release.migration_paired" is also added by detector "migrations"',
    ]);
  });
});

describe("playbook refs", () => {
  it("round-trips name@version", () => {
    expect(playbookRef({ name: "PMA", version: "1.2.0" })).toBe("PMA@1.2.0");
    expect(parsePlaybookRef("PMA@1.2.0")).toEqual({ name: "PMA", version: "1.2.0" });
    expect(parsePlaybookRef("sdlc@10.0.3")).toEqual({ name: "sdlc", version: "10.0.3" });
  });

  it("rejects anything else", () => {
    for (const ref of ["sdlc", "sdlc@", "@1.0.0", "sdlc@1.0", "sdlc@v1.0.0", "my sdlc@1.0.0"]) {
      expect(parsePlaybookRef(ref)).toBeUndefined();
    }
  });
});
