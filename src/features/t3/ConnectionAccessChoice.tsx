"use client";

import type { AccessLevel } from "./contract";
import { accessLevels, consentExplanation, consentGuidance } from "./ui";
import styles from "./Dashboard.module.css";

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
 *
 * The guidance below is not decoration. T3 ignores the requested OAuth scope
 * and grants exactly the mode the owner picks on its own consent screen, so
 * the owner must know which mode is compatible before leaving Helm.
 */
export function ConnectionAccessChoice({ value, onChange, disabled = false }: ConnectionAccessChoiceProps) {
  const guidance = consentGuidance(value);
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
      <div className={styles.consentGuidance} role="note" aria-live="polite">
        <p><strong>On T3&apos;s approval screen,</strong> {guidance.choice}</p>
        {guidance.fullAccess ? <p>{guidance.fullAccess}</p> : null}
        <p>{consentExplanation}</p>
      </div>
    </fieldset>
  );
}
