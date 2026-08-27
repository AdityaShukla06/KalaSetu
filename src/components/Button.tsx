import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

type Variant = "primary" | "secondary" | "tertiary" | "destructive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  icon,
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, className].filter(Boolean).join(" ");

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <>
          <span className="btn-spinner" aria-hidden="true" />
          <span>Wait...</span>
        </>
      ) : (
        <>
          {icon && (
            <span className="btn-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          <span>{children}</span>
        </>
      )}
    </button>
  );
}
