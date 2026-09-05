import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { AppProviders } from "./context/AppProviders";
import { useAuth, roleLandingPath } from "./context/AuthContext";
import type { UserRole } from "./services/api";
import { BottomNav } from "./components/BottomNav";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppBanners } from "./components/AppBanners";
import { LoginScreen } from "./screens/Onboarding/LoginScreen";
import { HomeScreen } from "./screens/Home/HomeScreen";
import { AddProductScreen } from "./screens/AddProduct/AddProductScreen";
import { VoiceDescribeScreen } from "./screens/AddProduct/VoiceDescribeScreen";
import { PricingScreen } from "./screens/AddProduct/PricingScreen";
import { ProfileScreen } from "./screens/Profile/ProfileScreen";
import { MarketplaceLayout } from "./screens/Marketplace/MarketplaceLayout";
import { BrowseScreen } from "./screens/Marketplace/BrowseScreen";
import { ProductDetailScreen } from "./screens/Marketplace/ProductDetailScreen";
import { BuyerProfileScreen } from "./screens/Marketplace/BuyerProfileScreen";
import { AdminScreen } from "./screens/Admin/AdminScreen";

function AppLayout() {
  return (
    <>
      <Outlet />
      <BottomNav />
    </>
  );
}

function RequireAuth() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
}

function RedirectIfAuthed() {
  const { isAuthenticated, role } = useAuth();
  return isAuthenticated ? <Navigate to={roleLandingPath(role ?? "artisan")} replace /> : <Outlet />;
}

function RequireRole({ role }: { role: UserRole }) {
  const { role: currentRole } = useAuth();
  return currentRole === role ? <Outlet /> : <Navigate to={roleLandingPath(currentRole ?? "artisan")} replace />;
}

function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <AppBanners />
        <BrowserRouter>
          <Routes>
            <Route element={<RedirectIfAuthed />}>
              <Route path="/login" element={<LoginScreen />} />
            </Route>

            <Route element={<RequireAuth />}>
              <Route element={<RequireRole role="buyer" />}>
                <Route element={<MarketplaceLayout />}>
                  <Route path="/marketplace" element={<BrowseScreen />} />
                  <Route path="/marketplace/profile" element={<BuyerProfileScreen />} />
                  <Route path="/marketplace/:productId" element={<ProductDetailScreen />} />
                </Route>
              </Route>

              <Route element={<RequireRole role="admin" />}>
                <Route path="/admin" element={<AdminScreen />} />
              </Route>

              <Route element={<RequireRole role="artisan" />}>
                <Route path="/add-product/photo" element={<AddProductScreen />} />
                <Route path="/add-product/describe" element={<VoiceDescribeScreen />} />
                <Route path="/add-product/price" element={<PricingScreen />} />

                <Route element={<AppLayout />}>
                  <Route path="/" element={<HomeScreen />} />
                  <Route path="/profile" element={<ProfileScreen />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}

export default App;
