import { useRef, type ChangeEvent, type KeyboardEvent } from "react";
import "./OtpInput.css";

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: boolean;
}

export function OtpInput({ length = 6, value, onChange, disabled, error }: OtpInputProps) {
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  function setDigits(next: string) {
    onChange(next.slice(0, length));
  }

  function handleChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value.replace(/\D/g, "");

    if (!raw) {
      const chars = value.split("");
      chars[index] = "";
      setDigits(chars.join(""));
      return;
    }

    const chars = value.split("");
    for (let i = 0; i < raw.length && index + i < length; i++) {
      chars[index + i] = raw[i];
    }
    setDigits(chars.join(""));

    const nextIndex = Math.min(index + raw.length, length - 1);
    inputsRef.current[nextIndex]?.focus();
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  }

  return (
    <div className={`otp-input${error ? " otp-input-error" : ""}`} role="group" aria-label="OTP">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            inputsRef.current[index] = el;
          }}
          className="otp-box"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={digit}
          disabled={disabled}
          autoFocus={index === 0}
          onChange={(event) => handleChange(index, event)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          aria-label={`Digit ${index + 1}`}
        />
      ))}
    </div>
  );
}
