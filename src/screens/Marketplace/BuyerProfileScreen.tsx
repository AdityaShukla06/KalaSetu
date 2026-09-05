import { useCallback, useEffect, useState } from "react";
import { Input } from "../../components/Input";
import { Button } from "../../components/Button";
import { LanguageSelect } from "../../components/LanguageSelect";
import { RegionSelect } from "../../components/RegionSelect";
import { getMyProfile, updateMyProfile, listMyInquiries } from "../../services/api";
import type { UserProfile, Inquiry } from "../../services/api";
import { useLanguage } from "../../context/LanguageContext";
import "./BuyerProfile.css";

type LoadState = "loading" | "error" | "loaded";

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

const STATUS_LABEL_KEY: Record<Inquiry["status"], string> = {
  open: "marketplace.inquiryStatusOpen",
  closed: "marketplace.inquiryStatusClosed",
};

export function BuyerProfileScreen() {
  const { language, t } = useLanguage();

  const [state, setState] = useState<LoadState>("loading");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [region, setRegion] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const [inquiriesState, setInquiriesState] = useState<LoadState>("loading");
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);

  const loadProfile = useCallback(async () => {
    setState("loading");
    try {
      const result = await getMyProfile();
      setProfile(result);
      setDisplayName(result.displayName ?? "");
      setCompanyName(result.shopName ?? "");
      setRegion(result.region ?? "");
      setState("loaded");
    } catch {
      setState("error");
    }
  }, []);

  const loadInquiries = useCallback(async () => {
    setInquiriesState("loading");
    try {
      const result = await listMyInquiries();
      setInquiries(result);
      setInquiriesState("loaded");
    } catch {
      setInquiriesState("error");
    }
  }, []);

  useEffect(() => {
    loadProfile();
    loadInquiries();
  }, [loadProfile, loadInquiries]);

  const dirty =
    profile !== null &&
    (displayName.trim() !== (profile.displayName ?? "") ||
      companyName.trim() !== (profile.shopName ?? "") ||
      region !== (profile.region ?? ""));

  async function handleSave() {
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      await updateMyProfile({
        displayName: displayName.trim(),
        shopName: companyName.trim(),
        region: region || undefined,
      });
      setProfile((prev) =>
        prev ? { ...prev, displayName: displayName.trim(), shopName: companyName.trim(), region: region || null } : prev,
      );
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="buyer-profile">
      <h1>{t("profile.title")}</h1>

      {state === "loading" && <p className="body-s">{t("profile.loading")}</p>}

      {state === "error" && (
        <div className="buyer-profile-section">
          <p className="onboarding-error" role="alert">
            {t("profile.loadError")}
          </p>
          <Button variant="secondary" icon={<RetryIcon />} onClick={loadProfile}>
            {t("home.retry")}
          </Button>
        </div>
      )}

      {state === "loaded" && profile && (
        <div className="buyer-profile-section">
          <p className="caption">{t("profile.emailLabel")}</p>
          <p className="body-s">{profile.email}</p>

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
            label={t("marketplace.companyNameLabel")}
            value={companyName}
            maxLength={120}
            onChange={(event) => {
              setCompanyName(event.target.value);
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

          {saveError && (
            <p className="onboarding-error" role="alert">
              {t("profile.saveError")}
            </p>
          )}
          {saved && !dirty && <p className="body-s profile-saved">{t("profile.saved")}</p>}

          <Button variant="primary" icon={<SaveIcon />} loading={saving} disabled={!dirty} onClick={handleSave}>
            {t("profile.save")}
          </Button>
        </div>
      )}

      <div className="buyer-profile-section">
        <LanguageSelect label={t("welcome.languageLabel")} />
      </div>

      <div className="buyer-profile-section">
        <h3>{t("marketplace.myInquiriesTitle")}</h3>

        {inquiriesState === "loading" && <p className="body-s">{t("marketplace.inquiriesLoading")}</p>}

        {inquiriesState === "error" && (
          <div className="buyer-profile-inline-error">
            <p className="onboarding-error" role="alert">
              {t("marketplace.inquiriesLoadError")}
            </p>
            <Button variant="secondary" icon={<RetryIcon />} onClick={loadInquiries}>
              {t("home.retry")}
            </Button>
          </div>
        )}

        {inquiriesState === "loaded" && inquiries.length === 0 && (
          <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
            {t("marketplace.noInquiries")}
          </p>
        )}

        {inquiriesState === "loaded" && inquiries.length > 0 && (
          <ul className="inquiry-list">
            {inquiries.map((inquiry) => {
              const title = inquiry.product
                ? language === inquiry.product.localLanguage
                  ? inquiry.product.titleLocal
                  : inquiry.product.titleEn
                : t("marketplace.inquiryProductRemoved");

              return (
                <li key={inquiry.inquiryId} className="inquiry-list-item">
                  {inquiry.product && (
                    <img src={inquiry.product.imageUrl} alt="" className="inquiry-list-photo" />
                  )}
                  <div className="inquiry-list-body">
                    <p className="inquiry-list-title">{title}</p>
                    <p className="caption inquiry-list-message">{inquiry.message}</p>
                    <span className={`inquiry-status inquiry-status-${inquiry.status}`}>
                      {t(STATUS_LABEL_KEY[inquiry.status])}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
