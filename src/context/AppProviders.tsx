import type { ReactNode } from "react";
import { AuthProvider } from "./AuthContext";
import { LanguageProvider } from "./LanguageContext";
import { AddProductDraftProvider } from "./AddProductDraftContext";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <AuthProvider>
        <AddProductDraftProvider>{children}</AddProductDraftProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
