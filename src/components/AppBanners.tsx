import { InstallPrompt } from "./InstallPrompt";
import { OfflineBanner } from "./OfflineBanner";
import "./AppBanners.css";

export function AppBanners() {
  return (
    <div className="app-banners">
      <OfflineBanner />
      <InstallPrompt />
    </div>
  );
}
