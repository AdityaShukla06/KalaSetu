import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { LanguageToggle } from "../../components/LanguageToggle";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./Profile.css";

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

function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 3h4l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v4a2 2 0 0 1-2 2C11.4 20 4 12.6 4 5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProfileScreen() {
  const navigate = useNavigate();
  const { phoneNumber, logout } = useAuth();
  const { t } = useLanguage();

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="screen">
      <div className="profile-screen">
        <h1>{t("profile.title")}</h1>

        <div className="profile-section">
          <p className="caption">{t("profile.phoneLabel")}</p>
          <div className="profile-phone">
            <span className="profile-phone-icon" aria-hidden="true">
              <PhoneIcon />
            </span>
            <span className="profile-phone-value">+91 {phoneNumber}</span>
          </div>
        </div>

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
