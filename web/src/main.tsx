import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth";
import { ErrorBoundary } from "./components/ui";
import { Toaster } from "./toast";
import { installGlobalLogging } from "./logs";
import { isTauri } from "./api";

installGlobalLogging();

if (import.meta.env.PROD && "serviceWorker" in navigator && !isTauri()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // offline shell is a nice-to-have, never block startup
    });
  });
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root chybí");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <App />
        <Toaster />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
