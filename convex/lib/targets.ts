/**
 * Target mapping validation (EGA-679, F2 preparatory slice).
 *
 * F2 configures exactly ONE project: the repository an issue is dispatched to,
 * plus the Linear project and T3 environment/project identities that must match
 * it. This module is the domain half of that contract:
 *
 *   - `TargetMapping` is the typed, single-project identity. Every field is
 *     required. There is no optional field that silently falls back to a
 *     default: an absent piece of identity is a hard error, never a guess.
 *
 *   - `validateTargetMapping` enforces strict, field-specific validation
 *     (non-empty, no placeholder tokens, owner/repo format, UUID-shaped Linear
 *     project, usable git base ref).
 *
 *   - `resolveTarget` is the fail-closed selection used before any dispatch or
 *     connection check: a candidate identity (from the environment, a live
 *     discovery, or an operator submission) is accepted ONLY when it is fully
 *     valid AND identical to the stored mapping in every field. Any difference
 *     is an error naming the field. Helm never substitutes a different
 *     repository, Linear project, T3 environment/project or base ref.
 *
 *   - `selectSingleMapping` enforces "exactly one project" over stored rows:
 *     zero rows is a missing mapping, more than one is ambiguous. Both fail
 *     closed.
 *
 * Pure functions only: no Convex imports, no network, no wall clock. All
 * inputs are explicit so tests and callers stay deterministic.
 */

/** Connection identifiers used across F2. */
export type ConnectionKind = "linear" | "t3";

/**
 * The single configured project identity (EGA-679 F2).
 *
 * All fields required, none optional. The values are exactly what dispatch
 * will use: repository for the checkout, Linear project for the issue list,
 * T3 environment/project/path for the execution target, baseRef for the git
 * branch new work starts from.
 */
export type TargetMapping = {
  /** Repository reference in "owner/repo" form, e.g. "EGA-BUILDS/helm". */
  repository: string;
  /** Linear project UUID (Settings > Projects in Linear). */
  linearProjectId: string;
  /** T3 environment id the checkout lives in. */
  t3EnvironmentId: string;
  /** T3 project id or path within the environment. */
  t3ProjectId: string;
  /** Git branch/ref new work is based on, e.g. "main". */
  baseRef: string;
};

export type TargetMappingField = keyof TargetMapping;

/** Field order is the validation and comparison order. */
const TARGET_MAPPING_FIELDS: readonly TargetMappingField[] = [
  "repository",
  "linearProjectId",
  "t3EnvironmentId",
  "t3ProjectId",
  "baseRef",
];

export type TargetMappingIssueCode =
  /** No mapping stored / mapping itself absent or malformed. */
  | "missing_mapping"
  /** A required field is absent, empty, or not a string. */
  | "missing_field"
  /** A field still holds an example placeholder from .env.example. */
  | "placeholder_value"
  /** repository is not a valid owner/repo reference. */
  | "invalid_repository"
  /** linearProjectId is not a UUID. */
  | "invalid_linear_project_id"
  /** baseRef is not a usable git ref. */
  | "invalid_base_ref"
  /** Candidate identity differs from the configured identity. */
  | "mismatched_identity"
  /** More than one mapping exists where exactly one is required. */
  | "ambiguous_target";

export type TargetMappingIssue = {
  code: TargetMappingIssueCode;
  /** Field the issue is about, when the issue is field-scoped. */
  field?: TargetMappingField;
  /** Operator-facing explanation. Never contains secret material. */
  message: string;
};

/**
 * Validation result. `issues` is always non-empty when `ok` is false so a
 * caller never has to guess why validation failed; the first issue names the
 * first problem in field order.
 */
export type TargetValidation =
  | { ok: true; mapping: TargetMapping }
  | { ok: false; issues: TargetMappingIssue[] };

/**
 * Placeholder tokens that mean "not configured yet" (see .env.example, e.g.
 * "YOUR_PUBLIC_T3_MCP_ENDPOINT"). Matched case-insensitively so a placeholder
 * can never sneak through by changing case.
 */
const PLACEHOLDER_TOKEN = /your_/i;

/**
 * GitHub-style "owner/repo": exactly one slash, each side starting and ending
 * with an alphanumeric, letters/digits/hyphen/underscore/dot inside. Enough to
 * reject "https://github.com/owner/repo", "owner/", "/repo", "owner repo" and
 * empty segments while accepting every real owner/repo pair.
 */
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Linear project ids are UUIDs (Settings > Projects in Linear). */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A usable git ref: starts alphanumeric, no whitespace and none of the
 * characters git forbids in ref names, no ".." (refusals / range ambiguity),
 * and does not end in "/" or ".lock".
 */
function isValidBaseRef(ref: string): boolean {
  if (!/^[A-Za-z0-9]/.test(ref)) return false;
  if (/[\s~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return true;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_TOKEN.test(value);
}

/**
 * Strictly validate an unknown value into a TargetMapping.
 *
 * Checks, per field, in order:
 *   1. present (not undefined/null) and a string;
 *   2. non-empty after trimming (the TRIMMED value is what gets returned, so
 *      later comparisons never disagree over whitespace);
 *   3. not an example placeholder;
 *   4. field format: owner/repo for repository, UUID for linearProjectId,
 *      usable git ref for baseRef. t3EnvironmentId and t3ProjectId must simply
 *      be non-empty, since T3 id formats are not assumed here.
 *
 * ALL issues found are returned, so the operator sees every problem at once
 * instead of one per round trip.
 */
export function validateTargetMapping(input: unknown): TargetValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_mapping",
          message: "target mapping is missing or is not an object",
        },
      ],
    };
  }

  const record = input as Record<string, unknown>;
  const issues: TargetMappingIssue[] = [];
  const trimmed: Partial<Record<TargetMappingField, string>> = {};

  for (const field of TARGET_MAPPING_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null) {
      issues.push({
        code: "missing_field",
        field,
        message: `target field "${field}" is missing`,
      });
      continue;
    }
    if (typeof raw !== "string") {
      issues.push({
        code: "missing_field",
        field,
        message: `target field "${field}" must be a string`,
      });
      continue;
    }
    const value = raw.trim();
    if (value === "") {
      issues.push({
        code: "missing_field",
        field,
        message: `target field "${field}" is empty`,
      });
      continue;
    }
    if (isPlaceholder(value)) {
      issues.push({
        code: "placeholder_value",
        field,
        message: `target field "${field}" still holds the example placeholder "${value}"`,
      });
      continue;
    }
    trimmed[field] = value;
  }

  // Format checks run only when the field itself passed, so a single bad
  // field never produces a cascade of misleading secondary errors.
  if (trimmed.repository !== undefined && !REPOSITORY_PATTERN.test(trimmed.repository)) {
    issues.push({
      code: "invalid_repository",
      field: "repository",
      message: `repository "${trimmed.repository}" is not a valid owner/repo reference`,
    });
  }
  if (
    trimmed.linearProjectId !== undefined &&
    !UUID_PATTERN.test(trimmed.linearProjectId)
  ) {
    issues.push({
      code: "invalid_linear_project_id",
      field: "linearProjectId",
      message: `linearProjectId "${trimmed.linearProjectId}" is not a UUID (Settings > Projects in Linear)`,
    });
  }
  if (trimmed.baseRef !== undefined && !isValidBaseRef(trimmed.baseRef)) {
    issues.push({
      code: "invalid_base_ref",
      field: "baseRef",
      message: `baseRef "${trimmed.baseRef}" is not a usable git ref`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, mapping: trimmed as TargetMapping };
}

/**
 * Fail-closed selection of the dispatch target.
 *
 * `stored` is the configuration of record (exactly one mapping, already
 * validated when seeded). `candidate` is any other claim about the target:
 * environment values, a live discovery, an operator edit. The candidate is
 * accepted only when it is fully valid AND equal to the stored mapping in
 * every field. On any difference the result is a `mismatched_identity` issue
 * naming the field and both values — Helm never "corrects" a mismatch by
 * adopting the candidate, and never falls back to a different repository,
 * Linear project, T3 environment/project or base ref.
 *
 * On success the STORED mapping is returned, making the no-substitution rule
 * structural: the candidate cannot become the target even by accident.
 */
export function resolveTarget(input: {
  stored: TargetMapping | null;
  candidate: unknown;
}): TargetValidation {
  if (input.stored === null) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_mapping",
          message:
            "no project mapping has been configured; the owner must save the target mapping before dispatch",
        },
      ],
    };
  }

  const validated = validateTargetMapping(input.candidate);
  if (!validated.ok) {
    return validated;
  }

  const issues: TargetMappingIssue[] = [];
  for (const field of TARGET_MAPPING_FIELDS) {
    if (validated.mapping[field] !== input.stored[field]) {
      issues.push({
        code: "mismatched_identity",
        field,
        message:
          `target identity mismatch in "${field}": configured "${input.stored[field]}" ` +
          `but the candidate says "${validated.mapping[field]}"`,
      });
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, mapping: input.stored };
}

/**
 * Select the one configured mapping from stored rows.
 *
 * Helm supports exactly one project (F2 scope: "Not included: multi-project
 * setup"). Zero rows fail as `missing_mapping`; two or more fail as
 * `ambiguous_target` rather than picking the first, because a silently chosen
 * project could dispatch to the wrong repository.
 */
export function selectSingleMapping(rows: readonly unknown[]): TargetValidation {
  if (rows.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_mapping",
          message: "no project mapping is stored; the owner must configure the single project first",
        },
      ],
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      issues: [
        {
          code: "ambiguous_target",
          message:
            `expected exactly one project mapping but found ${rows.length}; ` +
            "Helm supports a single project, so this must be resolved before dispatch",
        },
      ],
    };
  }
  return validateTargetMapping(rows[0]);
}

/**
 * Proposed environment variable names for the target mapping.
 *
 * LINEAR_PROJECT_ID already exists in .env.example and is read by the EGA-677
 * setup diagnostics. The other four names are this slice's proposal for the F2
 * setup operation; the integrator wires them when seeding the mapping.
 */
export const TARGET_ENV_VARS = {
  repository: "HELM_REPOSITORY",
  linearProjectId: "LINEAR_PROJECT_ID",
  t3EnvironmentId: "T3_ENVIRONMENT_ID",
  t3ProjectId: "T3_PROJECT_ID",
  baseRef: "HELM_BASE_REF",
} as const satisfies Record<TargetMappingField, string>;

/**
 * Build a TargetMapping from raw environment values.
 *
 * This is the seeding entry point for the F2 internal setup operation: it
 * routes the environment through the same strict validation, so a bad
 * environment can never silently produce a half-configured target.
 */
export function targetMappingFromEnv(
  env: Partial<Record<(typeof TARGET_ENV_VARS)[TargetMappingField], string>>,
): TargetValidation {
  return validateTargetMapping({
    repository: env[TARGET_ENV_VARS.repository],
    linearProjectId: env[TARGET_ENV_VARS.linearProjectId],
    t3EnvironmentId: env[TARGET_ENV_VARS.t3EnvironmentId],
    t3ProjectId: env[TARGET_ENV_VARS.t3ProjectId],
    baseRef: env[TARGET_ENV_VARS.baseRef],
  });
}
