import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { AppProviders } from "./context/AppProviders";
import { useAuth } from "./context/AuthContext";
import { BottomNav } from "./components/BottomNav";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppBanners } from "./components/AppBanners";
import { LoginScreen } from "./screens/Onboarding/LoginScreen";
import { HomeScreen } from "./screens/Home/HomeScreen";
import { AddProductScreen } from "./screens/AddProduct/AddProductScreen";
import { VoiceDescribeScreen } from "./screens/AddProduct/VoiceDescribeScreen";
import { PricingScreen } from "./screens/AddProduct/PricingScreen";
import { ProfileScreen } from "./screens/Profile/ProfileScreen";

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
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/" replace /> : <Outlet />;
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
              <Route path="/add-product/photo" element={<AddProductScreen />} />
              <Route path="/add-product/describe" element={<VoiceDescribeScreen />} />
              <Route path="/add-product/price" element={<PricingScreen />} />

              <Route element={<AppLayout />}>
                <Route path="/" element={<HomeScreen />} />
                <Route path="/profile" element={<ProfileScreen />} />
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
