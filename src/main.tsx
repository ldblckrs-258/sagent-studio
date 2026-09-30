import "@fontsource-variable/archivo";
import "@fontsource-variable/archivo/wght-italic.css";
import "@fontsource-variable/jetbrains-mono";
import { Analytics } from "@vercel/analytics/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { handleMcpOAuthCallback } from "./mcp/oauth-callback";
import { capturePairingFragment } from "./terminal/pairing";
import { ErrorBoundary } from "./vault/ErrorBoundary";
import { useVaultStore } from "./vault/store";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  if (!reason || typeof reason !== "object" || !("name" in reason)) return;
  const name = (reason as { name: unknown }).name;
  if (typeof name !== "string") return;

  // Benign, expected outcomes: a wrong password is reported inline by the unlock
  // form, and a locked write is a lost race, not a corrupt vault. Neither may
  // promote the UI to the erase-only recovery screen.
  if (name === "WrongPasswordError" || name === "VaultLockedError") return;

  const error =
    reason instanceof Error
      ? reason.message
      : "An unknown vault error occurred.";

  if (name === "CorruptVaultError" || name === "MalformedBlobError") {
    useVaultStore.setState({ error, status: "recovering" });
    return;
  }

  if (name.startsWith("Vault") || name === "InsecureContextError") {
    useVaultStore.setState({ error });
  }
});

capturePairingFragment(window);

if (handleMcpOAuthCallback(window)) {
  document.getElementById("root")!.textContent =
    "Sign-in finished. You can close this window.";
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
        <Analytics />
      </ErrorBoundary>
    </StrictMode>,
  );
}
