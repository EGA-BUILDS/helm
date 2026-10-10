import { describe, expect, it } from "vitest";
import {
  resolveTarget,
  selectSingleMapping,
  targetMappingFromEnv,
  validateTargetMapping,
  type TargetMapping,
} from "./targets";

/**
 * EGA-679 F2 preparatory slice: target mapping validation.
 *
 * Fixtures are sanitized: they use synthetic ids and a synthetic repo. No
 * real deployment, Linear project or T3 identity appears here.
 */
describe("validateTargetMapping", () => {
  const valid: TargetMapping = {
    repository: "EGA-BUILDS/helm",
    linearProjectId: "12345678-1234-5678-1234-567812345678",
    t3EnvironmentId: "env-00000000-0000-0000-0000-0000000000aa",
    t3ProjectId: "proj-00000000-0000-0000-0000-0000000000bb",
    baseRef: "main",
  };

  it("accepts a complete, well-formed mapping and trims whitespace", () => {
    const result = validateTargetMapping({
      repository: "  EGA-BUILDS/helm  ",
      linearProjectId: valid.linearProjectId,
      t3EnvironmentId: "  env-00000000-0000-0000-0000-0000000000aa ",
      t3ProjectId: valid.t3ProjectId,
      baseRef: " main ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mapping).toEqual(valid);
    }
  });

  it("rejects a non-object input as missing_mapping", () => {
    for (const input of [null, undefined, 42, "EGA-BUILDS/helm", true]) {
      const result = validateTargetMapping(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.code).toBe("missing_mapping");
      }
    }
  });

  it("rejects an array as missing_mapping, not as a field-scoped problem", () => {
    const result = validateTargetMapping([valid]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe("missing_mapping");
    }
  });

  it("reports every missing field by name", () => {
    const result = validateTargetMapping({ repository: "EGA-BUILDS/helm" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missing = result.issues.filter((i) => i.code === "missing_field");
      expect(missing.map((i) => i.field).sort()).toEqual([
        "baseRef",
        "linearProjectId",
        "t3EnvironmentId",
        "t3ProjectId",
      ]);
      for (const issue of missing) {
        expect(issue.message).toContain(`target field "${issue.field}"`);
      }
    }
  });

  it("names the field for empty strings and whitespace-only values", () => {
    const result = validateTargetMapping({
      repository: "",
      linearProjectId: "   ",
      t3EnvironmentId: "",
      t3ProjectId: "",
      baseRef: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(5);
      for (const issue of result.issues) {
        expect(issue.code).toBe("missing_field");
        expect(issue.message).toContain("is empty");
      }
    }
  });

  it("treats non-string fields as missing_field", () => {
    const result = validateTargetMapping({
      repository: "EGA-BUILDS/helm",
      linearProjectId: 42,
      t3EnvironmentId: null,
      t3ProjectId: true,
      baseRef: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.field).sort()).toEqual([
        "baseRef",
        "linearProjectId",
        "t3EnvironmentId",
        "t3ProjectId",
      ]);
      for (const issue of result.issues) {
        expect(issue.code).toBe("missing_field");
      }
    }
  });

  it("rejects placeholder values in any field, case-insensitively", () => {
    const result = validateTargetMapping({
      repository: "EGA-BUILDS/helm",
      linearProjectId: "12345678-1234-5678-1234-567812345678",
      t3EnvironmentId: "YOUR_T3_ENVIRONMENT_ID",
      t3ProjectId: "your_t3_project_id",
      baseRef: "main",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const placeholders = result.issues.filter((i) => i.code === "placeholder_value");
      expect(placeholders.map((i) => i.field).sort()).toEqual([
        "t3EnvironmentId",
        "t3ProjectId",
      ]);
    }
  });

  it("rejects the known .env.example placeholder URLs in the t3 fields", () => {
    const result = validateTargetMapping({
      repository: "EGA-BUILDS/helm",
      linearProjectId: "12345678-1234-5678-1234-567812345678",
      t3EnvironmentId: "https://YOUR_PUBLIC_T3_MCP_ENDPOINT/mcp",
      t3ProjectId: "proj-00000000-0000-0000-0000-0000000000bb",
      baseRef: "main",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("placeholder_value");
      expect(result.issues[0]?.field).toBe("t3EnvironmentId");
    }
  });

  it("rejects malformed repository references as invalid_repository", () => {
    const malformed = [
      "https://github.com/EGA-BUILDS/helm",
      "EGA-BUILDS",
      "/helm",
      "EGA-BUILDS/",
      "EGA BUILDS/helm",
      "EGA-BUILDS/helm/tree/main",
      "EGA-BUILDS//helm",
      "",
    ];
    for (const repository of malformed) {
      const result = validateTargetMapping({ ...valid, repository });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const issue = result.issues.find((i) => i.field === "repository");
        expect(issue).toBeDefined();
        expect(issue?.code).toBe(repository === "" ? "missing_field" : "invalid_repository");
      }
    }
  });

  it("accepts realistic owner/repo forms", () => {
    for (const repository of ["EGA-BUILDS/helm", "owner/repo", "a/b", "my-org/my.repo-2"]) {
      const result = validateTargetMapping({ ...valid, repository });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a non-UUID linearProjectId as invalid_linear_project_id", () => {
    const bad = [
      "EGA-PROJECTS",
      "12345678123456781234567812345678",
      "12345678-1234-5678-1234",
      " 12345678-1234-5678-1234-567812345678 ", // trimmed first, so this passes
    ];
    for (const linearProjectId of bad) {
      const result = validateTargetMapping({ ...valid, linearProjectId });
      if (linearProjectId.startsWith(" ")) {
        // Whitespace is trimmed during validation, so this value is valid.
        expect(result.ok).toBe(true);
        continue;
      }
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const issue = result.issues.find((i) => i.field === "linearProjectId");
        expect(issue?.code).toBe("invalid_linear_project_id");
      }
    }
  });

  it("rejects unusable base refs as invalid_base_ref", () => {
    const bad = ["", ".", "-main", "feature/../x", "has space", "a~b", "a:b", "a?b", "a*b", "a[b", "a\\b", "main/", "main.lock"];
    for (const baseRef of bad) {
      const result = validateTargetMapping({ ...valid, baseRef });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const issue = result.issues.find((i) => i.field === "baseRef");
        expect(issue).toBeDefined();
        expect(issue?.code).toBe(baseRef === "" ? "missing_field" : "invalid_base_ref");
      }
    }
  });

  it("accepts realistic base refs", () => {
    for (const baseRef of ["main", "master", "ega-679", "feature/ega-679", "v1.2.3", "release-2026.10"]) {
      const result = validateTargetMapping({ ...valid, baseRef });
      expect(result.ok).toBe(true);
    }
  });
});

describe("resolveTarget", () => {
  const stored: TargetMapping = {
    repository: "EGA-BUILDS/helm",
    linearProjectId: "12345678-1234-5678-1234-567812345678",
    t3EnvironmentId: "env-00000000-0000-0000-0000-0000000000aa",
    t3ProjectId: "proj-00000000-0000-0000-0000-0000000000bb",
    baseRef: "main",
  };

  it("fails closed when no mapping is stored", () => {
    const result = resolveTarget({ stored: null, candidate: stored });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("missing_mapping");
    }
  });

  it("accepts a fully valid candidate identical to the stored mapping", () => {
    const result = resolveTarget({ stored, candidate: { ...stored } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The STORED mapping is returned, never the candidate's.
      expect(result.mapping).toEqual(stored);
    }
  });

  it("rejects an invalid candidate and reports its own issues", () => {
    const result = resolveTarget({
      stored,
      candidate: { ...stored, repository: "" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("missing_field");
      expect(result.issues[0]?.field).toBe("repository");
    }
  });

  it("rejects a repository mismatch as mismatched_identity, naming the field", () => {
    const result = resolveTarget({
      stored,
      candidate: { ...stored, repository: "EGA-BUILDS/other-repo" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.code).toBe("mismatched_identity");
      expect(result.issues[0]?.field).toBe("repository");
      expect(result.issues[0]?.message).toContain("EGA-BUILDS/helm");
      expect(result.issues[0]?.message).toContain("EGA-BUILDS/other-repo");
    }
  });

  it("rejects a t3 environment mismatch (env says A, config says B)", () => {
    const result = resolveTarget({
      stored,
      candidate: { ...stored, t3EnvironmentId: "env-ffffffff-0000-0000-0000-0000000000ff" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("mismatched_identity");
      expect(result.issues[0]?.field).toBe("t3EnvironmentId");
    }
  });

  it("reports every mismatched field, not just the first", () => {
    const result = resolveTarget({
      stored,
      candidate: {
        ...stored,
        t3ProjectId: "proj-11111111-0000-0000-0000-0000000000cc",
        baseRef: "develop",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const mismatched = result.issues.filter((i) => i.code === "mismatched_identity");
      expect(mismatched.map((i) => i.field).sort()).toEqual(["baseRef", "t3ProjectId"]);
    }
  });

  it("never substitutes: a mismatch error means no target comes back at all", () => {
    const result = resolveTarget({
      stored,
      candidate: { ...stored, baseRef: "somebody-elses-branch" },
    });
    // Fail-closed: there is no ok:true branch that could silently carry a
    // substituted mapping, so the dispatch target simply does not exist.
    expect(result.ok).toBe(false);
  });
});

describe("selectSingleMapping", () => {
  const valid: TargetMapping = {
    repository: "EGA-BUILDS/helm",
    linearProjectId: "12345678-1234-5678-1234-567812345678",
    t3EnvironmentId: "env-00000000-0000-0000-0000-0000000000aa",
    t3ProjectId: "proj-00000000-0000-0000-0000-0000000000bb",
    baseRef: "main",
  };

  it("fails closed on zero rows as missing_mapping", () => {
    const result = selectSingleMapping([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("missing_mapping");
    }
  });

  it("fails closed on more than one row as ambiguous_target", () => {
    const result = selectSingleMapping([valid, { ...valid, baseRef: "develop" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("ambiguous_target");
    }
  });

  it("accepts exactly one valid row", () => {
    const result = selectSingleMapping([valid]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mapping).toEqual(valid);
    }
  });

  it("validates the single row rather than trusting it", () => {
    const result = selectSingleMapping([{ ...valid, repository: "not-a-repo" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("invalid_repository");
    }
  });
});

describe("targetMappingFromEnv", () => {
  const env = {
    HELM_REPOSITORY: "EGA-BUILDS/helm",
    LINEAR_PROJECT_ID: "12345678-1234-5678-1234-567812345678",
    T3_ENVIRONMENT_ID: "env-00000000-0000-0000-0000-0000000000aa",
    T3_PROJECT_ID: "proj-00000000-0000-0000-0000-0000000000bb",
    HELM_BASE_REF: "main",
  };

  it("accepts a fully configured environment", () => {
    const result = targetMappingFromEnv(env);
    expect(result.ok).toBe(true);
  });

  it("rejects an incomplete environment, naming the missing field", () => {
    const incomplete: Partial<typeof env> = { ...env };
    delete incomplete.HELM_BASE_REF;
    const result = targetMappingFromEnv(incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("missing_field");
      expect(result.issues[0]?.field).toBe("baseRef");
    }
  });

  it("rejects placeholder environment values", () => {
    const result = targetMappingFromEnv({ ...env, HELM_REPOSITORY: "YOUR_REPOSITORY" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("placeholder_value");
    }
  });
});
