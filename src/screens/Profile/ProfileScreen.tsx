import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { LanguageToggle } from "../../components/LanguageToggle";
import { getMyProfile, updateMyProfile, type UserProfile } from "../../services/api";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Profile.css";

type LoadState = "loading" | "error" | "loaded";

function LogoutIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m3.5 7 8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 5 5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 11a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v5h-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ProfileScreen() {
  const navigate = useNavigate();
  const { email, logout } = useAuth();
  const { t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [shopName, setShopName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const loadProfile = useCallback(async () => {
    setState("loading");
    try {
      const result = await getMyProfile();
      setProfile(result);
      setDisplayName(result.displayName ?? "");
      setShopName(result.shopName ?? "");
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const dirty =
    profile !== null &&
    (displayName.trim() !== (profile.displayName ?? "") || shopName.trim() !== (profile.shopName ?? ""));

  async function handleSave() {
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      await updateMyProfile({ displayName: displayName.trim(), shopName: shopName.trim() });
      setProfile((prev) =>
        prev ? { ...prev, displayName: displayName.trim(), shopName: shopName.trim() } : prev,
      );
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  const shownEmail = profile?.email || email;

  return (
    <div className="screen">
      <div className="profile-screen">
        <h1>{t("profile.title")}</h1>

        <div className="profile-section">
          <p className="caption">{t("profile.emailLabel")}</p>
          <div className="profile-phone">
            <span className="profile-phone-icon" aria-hidden="true">
              <MailIcon />
            </span>
            <span className="profile-phone-value">
              {shownEmail || t("profile.emailUnknown")}
            </span>
          </div>
        </div>

        {state === "loading" && <p className="body-s">{t("profile.loading")}</p>}

        {state === "error" && (
          <div className="profile-section">
            <p className="onboarding-error" role="alert">
              {t("profile.loadError")}
            </p>
            <Button variant="secondary" icon={<RetryIcon />} onClick={loadProfile}>
              {t("home.retry")}
            </Button>
          </div>
        )}

        {state === "loaded" && (
          <div className="profile-section">
            <Input
              label={t("profile.displayNameLabel")}
              value={displayName}
              maxLength={80}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setSaved(false);
              }}
            />
            <Input
              label={t("profile.shopNameLabel")}
              value={shopName}
              maxLength={120}
              onChange={(event) => {
                setShopName(event.target.value);
                setSaved(false);
              }}
            />

            {saveError && (
              <p className="onboarding-error" role="alert">
                {t("profile.saveError")}
              </p>
            )}
            {saved && !dirty && <p className="body-s profile-saved">{t("profile.saved")}</p>}

            <Button
              variant="primary"
              icon={<SaveIcon />}
              loading={saving}
              disabled={!dirty}
              onClick={handleSave}
            >
              {t("profile.save")}
            </Button>
          </div>
        )}

        <div className="profile-section">
          <p className="caption">{t("welcome.languageLabel")}</p>
          <LanguageToggle />
        </div>

        <Button variant="secondary" icon={<LogoutIcon />} onClick={handleLogout}>
          {t("profile.logout")}
        </Button>
      </div>
    </div>
  );
}
