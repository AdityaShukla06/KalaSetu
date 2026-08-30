import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { sendOtp } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

interface EmailEntryScreenProps {
  onOtpSent: (email: string, emailDelivered: boolean) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function MailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m3.5 7 8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m4 4 16 8-16 8 4-8-4-8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function EmailEntryScreen({ onOtpSent }: EmailEntryScreenProps) {
  const { language, t } = useLanguage();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError(t("email.invalid"));
      return;
    }

    setSending(true);
    setError(null);

    try {
      const result = await sendOtp(trimmed);
      onOtpSent(trimmed, result.emailDelivered);
    } catch {
      setError(t("email.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="onboarding-screen" lang={language} onSubmit={handleSubmit}>
      <h1 className="onboarding-title">{t("email.title")}</h1>

      <Input
        label={t("email.label")}
        icon={<MailIcon />}
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          if (error) setError(null);
        }}
        error={error ?? undefined}
      />

      <p className="body-s onboarding-helper">{t("email.helper")}</p>

      <Button type="submit" variant="primary" icon={<SendIcon />} loading={sending}>
        {t("email.sendOtp")}
      </Button>
    </form>
  );
}
