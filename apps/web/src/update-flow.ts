import "./update-overlay.css";
import { openUpdateOverlay, updateCookieHeaders } from "./update-overlay.js";

export function openSaturnUpdates(component: "saturn" | "updater" | "neptune" | "gryphon" = "saturn") {
  return openUpdateOverlay({ service: "saturn", component, base: "/api/v1/operator/updates/flow",
    headers: () => updateCookieHeaders(["vault_csrf_dev", "__Host-vault_csrf"], "X-Vault-CSRF") });
}

export function openRemoteNeptuneUpdates(serviceId: string) {
  return openUpdateOverlay({ service: `saturn-remote-${serviceId}`, component: "neptune", base: `/api/v1/operator/neptune/agents/${encodeURIComponent(serviceId)}/update/flow`,
    headers: () => updateCookieHeaders(["vault_csrf_dev", "__Host-vault_csrf"], "X-Vault-CSRF") });
}
