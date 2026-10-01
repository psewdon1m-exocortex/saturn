import "./update-overlay.css";
import { openUpdateOverlay, updateCookieHeaders } from "./update-overlay.js";

export function openSaturnUpdates(component: "saturn" = "saturn") {
  return openUpdateOverlay({ service: "saturn", component, base: "/api/v1/operator/updates/flow",
    headers: () => updateCookieHeaders(["vault_csrf_dev", "__Host-vault_csrf"], "X-Vault-CSRF") });
}
