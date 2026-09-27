import { createContext } from "react";

// A fresh epoch even when the same account signs back into this document.
export const SessionScopeContext = createContext("unmounted");
