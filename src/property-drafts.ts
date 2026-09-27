import { createContext, useContext } from "react";

export type PropertyField = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  value: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  secret?: boolean;
};
export type PropertyConfig = {
  path: string;
  revision: string;
  fields: PropertyField[];
  status: string;
};
export type PropertyDraft = {
  config: PropertyConfig;
  values: Record<string, string | number | boolean>;
  // Present only while a page displaying this exact draft is mounted.
  onSaved?: (config: PropertyConfig) => void;
};

// Owned by the signed-in App, rather than by a page or a module singleton.
// Server navigation preserves edits; account changes release every draft.
export const PropertyDraftsContext = createContext(
  new Map<string, PropertyDraft>(),
);

export function useConfirmDiscardPropertyDrafts() {
  const drafts = useContext(PropertyDraftsContext);
  return () =>
    !drafts.size ||
    window.confirm(
      "Sign out and discard your unsaved Properties edits on this panel?",
    );
}
