import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { OtpInput } from "../../components/OtpInput";
import { sendOtp, verifyOtp, OTP_LENGTH, ApiError } from "../../services/api";
import type { SelfServeRole } from "../../services/api";
import { useAuth, roleLandingPath } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

const RESEND_COOLDOWN_SECONDS = 30;

interface OtpVerificationScreenProps {
  email: string;
  emailDelivered: boolean;
  intendedRole: SelfServeRole;
  onChangeEmail: () => void;
}

function ShieldIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OtpVerificationScreen({
  email,
  emailDelivered,
  intendedRole,
  onChangeEmail,
}: OtpVerificationScreenProps) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { language, t } = useLanguage();

  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [delivered, setDelivered] = useState(emailDelivered);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((prev) => Math.max(prev - 1, 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function handleOtpChange(value: string) {
    setOtp(value);
    if (error) setError(null);
  }

  async function handleVerify() {
    if (otp.length !== OTP_LENGTH) {
      setError(t("otp.invalid"));
      return;
    }

    setVerifying(true);
    setError(null);

    try {
      const { token, userId, email: verifiedEmail, role } = await verifyOtp(email, otp, intendedRole);
      login(token, userId, verifiedEmail, role);
      navigate(roleLandingPath(role), { replace: true });
    } catch (err) {
      setOtp("");
      if (err instanceof ApiError && err.code === "email_role_mismatch") {
        setError(t(intendedRole === "buyer" ? "otp.emailIsSeller" : "otp.emailIsBuyer"));
      } else if (err instanceof ApiError && err.code === "account_deactivated") {
        setError(t("otp.accountDeactivated"));
      } else {
        setError(t("otp.wrong"));
      }
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;

    setResending(true);
    setError(null);

    try {
      const result = await sendOtp(email);
      setDelivered(result.emailDelivered);
      setOtp("");
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError(t("otp.resendError"));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="onboarding-screen" lang={language}>
      <h1 className="onboarding-title">{t("otp.title")}</h1>
      <p className="body-s onboarding-helper">
        {t("otp.subtitle")} {email}
      </p>

      {!delivered && (
        <p className="body-s onboarding-helper onboarding-notice">{t("otp.emailUndelivered")}</p>
      )}

      <OtpInput
        length={OTP_LENGTH}
        value={otp}
        onChange={handleOtpChange}
        error={Boolean(error)}
        disabled={verifying}
      />

      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}

      <Button variant="primary" icon={<ShieldIcon />} loading={verifying} onClick={handleVerify}>
        {t("otp.verify")}
      </Button>

      <div className="onboarding-otp-actions">
        <button type="button" className="onboarding-link" onClick={onChangeEmail}>
          {t("otp.changeEmail")}
        </button>
        <button
          type="button"
          className="onboarding-link"
          onClick={handleResend}
          disabled={cooldown > 0 || resending}
        >
          {cooldown > 0 ? t("otp.resendIn", { n: cooldown }) : t("otp.resend")}
        </button>
      </div>
    </div>
  );
}
