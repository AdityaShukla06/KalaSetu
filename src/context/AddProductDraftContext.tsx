import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { ProductInput } from "../services/api";

export type AddProductDraft = Partial<ProductInput> & {
  imageBlob?: Blob;
  audioBlob?: Blob;
};

interface AddProductDraftContextValue {
  draft: AddProductDraft;
  updateDraft: (patch: Partial<AddProductDraft>) => void;
  resetDraft: () => void;
}

const AddProductDraftContext = createContext<AddProductDraftContextValue | undefined>(undefined);

const EMPTY_DRAFT: AddProductDraft = {};

export function AddProductDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<AddProductDraft>(EMPTY_DRAFT);

  const value = useMemo<AddProductDraftContextValue>(
    () => ({
      draft,
      updateDraft: (patch) => setDraft((prev) => ({ ...prev, ...patch })),
      resetDraft: () => setDraft(EMPTY_DRAFT),
    }),
    [draft],
  );

  return <AddProductDraftContext.Provider value={value}>{children}</AddProductDraftContext.Provider>;
}

export function useAddProductDraft(): AddProductDraftContextValue {
  const ctx = useContext(AddProductDraftContext);
  if (!ctx) throw new Error("useAddProductDraft must be used within an AddProductDraftProvider");
  return ctx;
}
