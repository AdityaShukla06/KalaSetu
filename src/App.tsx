import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { AppProviders } from "./context/AppProviders";
import { useAuth } from "./context/AuthContext";
import { BottomNav } from "./components/BottomNav";
import { WelcomeScreen } from "./screens/Onboarding/WelcomeScreen";
import { PhoneEntryScreen } from "./screens/Onboarding/PhoneEntryScreen";
import { OtpVerificationScreen } from "./screens/Onboarding/OtpVerificationScreen";
import { HomeScreen } from "./screens/Home/HomeScreen";
import { AddProductScreen } from "./screens/AddProduct/AddProductScreen";
import { VoiceDescribeScreen } from "./screens/AddProduct/VoiceDescribeScreen";
import { PlaceholderStepScreen } from "./screens/AddProduct/PlaceholderStepScreen";
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
  return isAuthenticated ? <Outlet /> : <Navigate to="/welcome" replace />;
}

function RedirectIfAuthed() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/" replace /> : <Outlet />;
}

function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <Routes>
          <Route element={<RedirectIfAuthed />}>
            <Route path="/welcome" element={<WelcomeScreen />} />
            <Route path="/phone" element={<PhoneEntryScreen />} />
            <Route path="/otp" element={<OtpVerificationScreen />} />
          </Route>

          <Route element={<RequireAuth />}>
            <Route path="/add-product" element={<AddProductScreen />} />
            <Route path="/add-product/describe" element={<VoiceDescribeScreen />} />
            <Route
              path="/add-product/price"
              element={
                <PlaceholderStepScreen
                  title="Pricing"
                  message="This step is not built yet. Your description has been saved to the draft."
                />
              }
            />

            <Route element={<AppLayout />}>
              <Route path="/" element={<HomeScreen />} />
              <Route path="/profile" element={<ProfileScreen />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;
