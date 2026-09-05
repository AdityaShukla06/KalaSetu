import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import "./ConsoleLayout.css";

export function ConsoleLayout() {
  const { logout } = useAuth();
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
    <div className="console-shell">
      <header className="console-nav">
        <span className="console-brand">KalaSetu Console</span>

        <nav className="console-nav-links" aria-label="Primary">
          <NavLink to="/internal/console" end className={({ isActive }) => `console-nav-link${isActive ? " console-nav-link-active" : ""}`}>
            Dashboard
          </NavLink>
          <NavLink to="/internal/console/artisans" className={({ isActive }) => `console-nav-link${isActive ? " console-nav-link-active" : ""}`}>
            Artisans
          </NavLink>
          <NavLink to="/internal/console/moderation" className={({ isActive }) => `console-nav-link${isActive ? " console-nav-link-active" : ""}`}>
            Moderation
          </NavLink>
          <NavLink to="/internal/console/flagged" className={({ isActive }) => `console-nav-link${isActive ? " console-nav-link-active" : ""}`}>
            Flagged
          </NavLink>
          <button type="button" className="console-nav-logout" onClick={handleLogout}>
            Log out
          </button>
        </nav>
      </header>

      <main className="console-content">
        <Outlet />
      </main>
    </div>
  );
}
