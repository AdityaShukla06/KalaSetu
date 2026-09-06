import { useEffect } from "react";
import { Outlet } from "react-router-dom";

export function AddProductLayout() {
  useEffect(() => {
    document.documentElement.style.setProperty("--shell-max-width", "none");
    return () => {
      document.documentElement.style.removeProperty("--shell-max-width");
    };
  }, []);

  return <Outlet />;
}
