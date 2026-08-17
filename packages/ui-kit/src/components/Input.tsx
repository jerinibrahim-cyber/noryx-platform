import * as React from "react";
import styles from "./Input.module.css";

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "id"
> {
  /** Unique id; auto-generated from `label` if omitted. */
  id?: string;
  label: string;
  /** Error message. When set, the field is marked invalid and this text replaces helperText. */
  error?: string;
  helperText?: string;
  required?: boolean;
}

let autoId = 0;

/**
 * Labeled text input with error and helper-text states. Always renders a
 * real `<label htmlFor>` and wires `aria-invalid` / `aria-describedby` so
 * assistive tech announces validation state correctly.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { id, label, error, helperText, required, className, ...rest },
    ref,
  ) {
    const generatedId = React.useRef(`noryx-input-${++autoId}`);
    const inputId = id ?? generatedId.current;
    const describedById = error
      ? `${inputId}-error`
      : helperText
        ? `${inputId}-helper`
        : undefined;

    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={inputId}>
          {label}
          {required ? (
            <span className={styles.required} aria-hidden="true">
              {" "}
              *
            </span>
          ) : null}
        </label>
        <input
          ref={ref}
          id={inputId}
          className={[styles.input, error ? styles.inputError : "", className]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedById}
          aria-required={required || undefined}
          required={required}
          {...rest}
        />
        {error ? (
          <span
            id={`${inputId}-error`}
            className={styles.errorText}
            role="alert"
          >
            {error}
          </span>
        ) : helperText ? (
          <span id={`${inputId}-helper`} className={styles.helperText}>
            {helperText}
          </span>
        ) : null}
      </div>
    );
  },
);

export default Input;
