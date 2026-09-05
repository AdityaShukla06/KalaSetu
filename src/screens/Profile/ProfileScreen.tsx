import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { LanguageSelect } from "../../components/LanguageSelect";
import { RegionSelect } from "../../components/RegionSelect";
import { getMyProfile, updateMyProfile, relocaliseProducts, type UserProfile } from "../../services/api";
import { isValidWhatsAppNumber } from "../../../shared/whatsapp";
import { isValidIndianPincode } from "../../../shared/shippingEstimator";
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
  const { language, t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [shopName, setShopName] = useState("");
  const [region, setRegion] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappError, setWhatsappError] = useState(false);
  const [pincode, setPincode] = useState("");
  const [pincodeError, setPincodeError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [relocaliseState, setRelocaliseState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [relocalisedCount, setRelocalisedCount] = useState(0);
  const syncedLanguage = useRef<string | null>(null);

  const loadProfile = useCallback(async () => {
    setState("loading");
    try {
      const result = await getMyProfile();
      setProfile(result);
      setDisplayName(result.displayName ?? "");
      setShopName(result.shopName ?? "");
      setRegion(result.region ?? "");
      setWhatsappNumber(result.whatsappNumber ?? "");
      setPincode(result.pincode ?? "");
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (state !== "loaded") return;

    if (syncedLanguage.current === null) {
      syncedLanguage.current = language;
      return;
    }
    if (syncedLanguage.current === language) return;

    syncedLanguage.current = language;
    let cancelled = false;

    (async () => {
      setRelocaliseState("working");
      try {
        await updateMyProfile({ language });
        const result = await relocaliseProducts(language);
        if (cancelled) return;
        setRelocalisedCount(result.updated);
        setRelocaliseState(result.failed > 0 ? "failed" : "done");
      } catch {
        if (!cancelled) setRelocaliseState("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [language, state]);

  const dirty =
    profile !== null &&
    (displayName.trim() !== (profile.displayName ?? "") ||
      shopName.trim() !== (profile.shopName ?? "") ||
      region !== (profile.region ?? "") ||
      whatsappNumber.trim() !== (profile.whatsappNumber ?? "") ||
      pincode.trim() !== (profile.pincode ?? ""));

  async function handleSave() {
    if (whatsappNumber.trim() && !isValidWhatsAppNumber(whatsappNumber.trim())) {
      setWhatsappError(true);
      return;
    }
    if (pincode.trim() && !isValidIndianPincode(pincode.trim())) {
      setPincodeError(true);
      return;
    }
    setWhatsappError(false);
    setPincodeError(false);
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      await updateMyProfile({
        displayName: displayName.trim(),
        shopName: shopName.trim(),
        region: region || undefined,
        whatsappNumber: whatsappNumber.trim(),
        pincode: pincode.trim(),
      });
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              displayName: displayName.trim(),
              shopName: shopName.trim(),
              region: region || null,
              whatsappNumber: whatsappNumber.trim() || null,
              pincode: pincode.trim() || null,
            }
          : prev,
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
      <div className="profile-screen artisan-form-column">
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
            <RegionSelect
              label={t("marketplace.regionLabel")}
              value={region}
              onChange={(value) => {
                setRegion(value);
                setSaved(false);
              }}
            />
            <Input
              label={t("profile.whatsappLabel")}
              type="tel"
              placeholder={t("profile.whatsappPlaceholder")}
              value={whatsappNumber}
              error={whatsappError ? t("profile.whatsappInvalid") : undefined}
              onChange={(event) => {
                setWhatsappNumber(event.target.value);
                setWhatsappError(false);
                setSaved(false);
              }}
            />
            <p className="caption profile-whatsapp-note">{t("profile.whatsappNote")}</p>
            <Input
              label={t("profile.pincodeLabel")}
              type="tel"
              inputMode="numeric"
              maxLength={6}
              placeholder={t("profile.pincodePlaceholder")}
              value={pincode}
              error={pincodeError ? t("profile.pincodeInvalid") : undefined}
              onChange={(event) => {
                setPincode(event.target.value);
                setPincodeError(false);
                setSaved(false);
              }}
            />
            <p className="caption profile-whatsapp-note">{t("profile.pincodeNote")}</p>

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
          <LanguageSelect label={t("welcome.languageLabel")} />
          {relocaliseState !== "idle" && (
            <p
              className={`body-s profile-relocalise profile-relocalise-${relocaliseState}`}
              aria-live="polite"
            >
              {relocaliseState === "working" && t("profile.relocalising")}
              {relocaliseState === "done" && t("profile.relocalised", { n: relocalisedCount })}
              {relocaliseState === "failed" && t("profile.relocaliseFailed")}
            </p>
          )}
        </div>

        <Button variant="secondary" icon={<LogoutIcon />} onClick={handleLogout}>
          {t("profile.logout")}
        </Button>
      </div>
    </div>
  );
}
