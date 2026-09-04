import { useAuth } from "../../context/AuthContext";
import "../Onboarding/Onboarding.css";

export function MarketplaceScreen() {
  const { logout } = useAuth();

  return (
    <div className="onboarding-screen onboarding-screen-center">
      <h1 className="onboarding-title">Buyer marketplace</h1>
      <p className="body-s onboarding-helper">
        The full marketplace is not built yet. You are signed in as a buyer, and the role and
        permission foundation for this screen is ready.
      </p>
      <button type="button" className="onboarding-link" onClick={logout}>
        Log out
      </button>
    </div>
  );
}
