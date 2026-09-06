import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { sendOtp } from "../../services/api";
import type { SelfServeRole } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

interface EmailEntryScreenProps {
  onOtpSent: (
    email: string,
    emailDelivered: boolean,
    intendedRole: SelfServeRole,
    requiresPassword: boolean,
  ) => void;
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

function ShopIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9v10h16V9M3 9l1.5-5h15L21 9M3 9h18M9 19v-5h6v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.8h7.7a2 2 0 0 0 2-1.6L21 8H6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="20" r="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="17.5" cy="20" r="1.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function EmailEntryScreen({ onOtpSent }: EmailEntryScreenProps) {
  const { language, t } = useLanguage();
  const [email, setEmail] = useState("");
  const [intendedRole, setIntendedRole] = useState<SelfServeRole>("artisan");
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
      onOtpSent(trimmed, result.emailDelivered, intendedRole, result.requiresPassword);
    } catch {
      setError(t("email.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="onboarding-screen" lang={language} onSubmit={handleSubmit}>
      <h1 className="onboarding-title">{t("email.title")}</h1>

      <div className="onboarding-section" role="radiogroup" aria-label={t("email.roleQuestion")}>
        <span className="body-s role-choice-label">{t("email.roleQuestion")}</span>
        <div className="role-choice-row">
          <button
            type="button"
            role="radio"
            aria-checked={intendedRole === "artisan"}
            className={`role-choice-card${intendedRole === "artisan" ? " role-choice-card-active" : ""}`}
            onClick={() => setIntendedRole("artisan")}
          >
            <ShopIcon />
            <span>{t("email.roleSell")}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={intendedRole === "buyer"}
            className={`role-choice-card${intendedRole === "buyer" ? " role-choice-card-active" : ""}`}
            onClick={() => setIntendedRole("buyer")}
          >
            <CartIcon />
            <span>{t("email.roleBuy")}</span>
          </button>
        </div>
      </div>

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
