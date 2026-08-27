import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { AppProviders } from "./context/AppProviders";
import { BottomNav } from "./components/BottomNav";
import { HomeScreen } from "./screens/Home/HomeScreen";
import { AddProductScreen } from "./screens/AddProduct/AddProductScreen";
import { ProfileScreen } from "./screens/Profile/ProfileScreen";

function AppLayout() {
  return (
    <>
      <Outlet />
      <BottomNav />
    </>
  );
}

function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/add-product" element={<AddProductScreen />} />
            <Route path="/profile" element={<ProfileScreen />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;
