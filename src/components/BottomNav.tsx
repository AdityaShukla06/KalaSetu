import { NavLink } from "react-router-dom";
import "./BottomNav.css";

function HomeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 11.5 12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3v-5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v5h3a1 1 0 0 0 1-1v-9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <NavLink
        to="/"
        end
        className={({ isActive }) => `bottom-nav-tab${isActive ? " bottom-nav-tab-active" : ""}`}
      >
        <HomeIcon />
        <span>My Shop</span>
      </NavLink>

      <NavLink
        to="/add-product"
        className="bottom-nav-center"
        aria-label="Add product"
      >
        <span className="bottom-nav-fab">
          <PlusIcon />
        </span>
        <span className="bottom-nav-center-label">Add</span>
      </NavLink>

      <NavLink
        to="/profile"
        className={({ isActive }) => `bottom-nav-tab${isActive ? " bottom-nav-tab-active" : ""}`}
      >
        <ProfileIcon />
        <span>Profile</span>
      </NavLink>
    </nav>
  );
}
