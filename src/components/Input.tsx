import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import "./Input.css";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  icon?: ReactNode;
  prefix?: string;
  error?: string;
}

export function Input({ label, icon, prefix, error, id, className, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        {icon && (
          <span className="field-label-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {label}
      </label>
      <div className={`field-input-wrap${error ? " field-input-wrap-error" : ""}`}>
        {prefix && <span className="field-prefix">{prefix}</span>}
        <input id={inputId} className={["field-input", className].filter(Boolean).join(" ")} {...rest} />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
