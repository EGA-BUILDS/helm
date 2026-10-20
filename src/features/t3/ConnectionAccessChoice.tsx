"use client";

import type { AccessLevel } from "./contract";
import { accessLevels } from "./ui";

export interface ConnectionAccessChoiceProps {
  value: AccessLevel;
  onChange: (value: AccessLevel) => void;
  disabled?: boolean;
}

/**
 * Explicit owner choice of the T3 access level before a consent flow starts.
 *
 * The choice is never inferred from an existing connection: widening from
 * read-only to operate always requires a fresh consent, so callers must reset
 * this to "read-only" and let the owner opt in again.
 */
export function ConnectionAccessChoice({ value, onChange, disabled = false }: ConnectionAccessChoiceProps) {
  return (
    <fieldset className="t3-access-choice" disabled={disabled}>
      <legend>Choose the access level for this T3 connection</legend>
      {accessLevels.map((level) => (
        <label key={level.id} className="t3-access-option">
          <input
            type="radio"
            name="t3-access-level"
            value={level.id}
            checked={value === level.id}
            onChange={() => onChange(level.id as AccessLevel)}
            disabled={disabled}
          />
          <span>
            <strong>{level.title}</strong>
            {level.id === "operate" ? <em>Widens access</em> : null}
            <small>{level.description}</small>
          </span>
        </label>
      ))}
      <p className="t3-access-warning">
        Operate widens access beyond read-only. T3 will show its own consent screen before anything is granted.
      </p>
    </fieldset>
  );
}