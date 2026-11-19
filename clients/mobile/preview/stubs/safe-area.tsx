import type { ReactNode } from "react";
export const SafeAreaProvider = ({ children }: { children: ReactNode }) => children;
// An iPhone with a Dynamic Island and a home indicator.
export const useSafeAreaInsets = () => ({ top: 54, bottom: 30, left: 0, right: 0 });
