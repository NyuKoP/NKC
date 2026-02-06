import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./index.css";
import App from "./app/App";

const isE2E = Boolean((import.meta as { env?: { VITE_E2E?: string } }).env?.VITE_E2E);
if (isE2E) {
  const fixedNow = new Date("2026-01-01T00:00:00Z").getTime();
  Date.now = () => fixedNow;
}

const root = document.getElementById("root");
const Router =
  typeof window !== "undefined" && window.location.protocol === "file:"
    ? HashRouter
    : BrowserRouter;

if (root) {
  createRoot(root).render(
    <Router>
      <App />
    </Router>
  );
}
