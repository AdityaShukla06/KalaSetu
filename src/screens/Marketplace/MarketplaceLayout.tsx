import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLanguage } from "../../context/LanguageContext";
import "./MarketplaceLayout.css";

function LogoIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9v10h16V9M3 9l1.5-5h15L21 9M3 9h18M9 19v-5h6v5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function MarketplaceLayout() {
  const { logout } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();

  useEffect(() => {
    document.documentElement.style.setProperty("--shell-max-width", "none");
    return () => {
      document.documentElement.style.removeProperty("--shell-max-width");
    };
  }, []);

  function handleLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="marketplace-shell">
      <header className="marketplace-nav">
        <NavLink to="/marketplace" className="marketplace-brand">
          <LogoIcon />
          <span>{t("app.name")}</span>
        </NavLink>

        <nav className="marketplace-nav-links" aria-label="Primary">
          <NavLink
            to="/marketplace"
            end
            className={({ isActive }) => `marketplace-nav-link${isActive ? " marketplace-nav-link-active" : ""}`}
          >
            {t("marketplace.navBrowse")}
          </NavLink>
          <NavLink
            to="/marketplace/profile"
            className={({ isActive }) => `marketplace-nav-link${isActive ? " marketplace-nav-link-active" : ""}`}
          >
            <ProfileIcon />
            {t("marketplace.navProfile")}
          </NavLink>
          <button type="button" className="marketplace-nav-logout" onClick={handleLogout}>
            {t("profile.logout")}
          </button>
        </nav>
      </header>

      <main className="marketplace-content">
        <Outlet />
      </main>
    </div>
  );
}
