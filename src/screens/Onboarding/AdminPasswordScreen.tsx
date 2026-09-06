import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { adminLogin, ApiError } from "../../services/api";
import { useAuth, roleLandingPath } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Onboarding.css";

interface AdminPasswordScreenProps {
  email: string;
  onChangeEmail: () => void;
}

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function AdminPasswordScreen({ email, onChangeEmail }: AdminPasswordScreenProps) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { language, t } = useLanguage();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError(t("adminLogin.passwordRequired"));
      return;
    }

    setVerifying(true);
    setError(null);

    try {
      const { token, userId, email: verifiedEmail, role } = await adminLogin(email, password);
      login(token, userId, verifiedEmail, role);
      navigate(roleLandingPath(role), { replace: true });
    } catch (err) {
      setPassword("");
      if (err instanceof ApiError && err.code === "account_locked") {
        setError(t("adminLogin.locked"));
      } else if (err instanceof ApiError && err.code === "account_deactivated") {
        setError(t("otp.accountDeactivated"));
      } else {
        setError(t("adminLogin.wrongPassword"));
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <form className="onboarding-screen" lang={language} onSubmit={handleSubmit}>
      <h1 className="onboarding-title">{t("adminLogin.title")}</h1>
      <p className="body-s onboarding-helper">
        {t("adminLogin.subtitle")} {email}
      </p>

      <Input
        label={t("adminLogin.passwordLabel")}
        icon={<LockIcon />}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          if (error) setError(null);
        }}
        disabled={verifying}
      />

      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" icon={<LockIcon />} loading={verifying}>
        {t("adminLogin.submit")}
      </Button>

      <div className="onboarding-otp-actions">
        <button type="button" className="onboarding-link" onClick={onChangeEmail}>
          {t("otp.changeEmail")}
        </button>
      </div>
    </form>
  );
}
