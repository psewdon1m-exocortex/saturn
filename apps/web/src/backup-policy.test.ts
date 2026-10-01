import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { mountBackupPolicy } from "./backup-policy.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

it("shows independent advanced pipeline states and updates both schedules through one control", async () => {
  let policy = {
    schema: "exocortex.backup.policy.v1", revision: 4, appliedRevision: 4, paused: false,
    archive: { enabled: false, intervalHours: 12 },
    mirror: { enabled: true, intervalMinutes: 300 },
    observed: { archive: { state: "archive-ready" }, mirror: { state: "mirror-delayed" } },
  };
  const mutations: Record<string, unknown>[] = [];
  localStorage.setItem("exocortex.backup-policy.v1.volt", JSON.stringify({
    body: { pipeline: "archive", requestId: "legacy-run" }, suffix: "/runs", method: "POST",
  }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).not.toBe("POST");
    if (init?.method === "PUT") {
      const body = JSON.parse(typeof init.body === "string" ? init.body : "") as Record<string, unknown>;
      mutations.push(body);
      policy = { ...policy, revision: policy.revision + 1,
        archive: { enabled: Boolean(body.enabled), intervalHours: Number(body.intervalHours) },
        mirror: { enabled: Boolean(body.enabled), intervalMinutes: Number(body.intervalHours) * 60 } };
    }
    return { ok: true, json: async () => policy };
  }));
  const root = document.createElement("div");
  document.body.append(root);
  const cleanup = mountBackupPolicy(root, { service: "volt", base: "/api/neptune/policy" });
  try {
    expect(localStorage.getItem("exocortex.backup-policy.v1.volt")).toBeNull();
    await waitFor(() => expect(root.querySelectorAll("[data-pipeline]")).toHaveLength(2));
    expect(root.querySelector('[data-pipeline="archive"]')?.textContent).toContain("archive-ready");
    expect(root.querySelector('[data-pipeline="mirror"]')?.textContent).toContain("mirror-delayed");
    expect(root.querySelectorAll('.exo-agent-group input[type="checkbox"]')).toHaveLength(1);
    const checkbox = root.querySelector<HTMLInputElement>('.exo-agent-group input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    if (checkbox === null) throw new Error("Backup policy checkbox is missing");
    expect(checkbox.indeterminate).toBe(true);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ kind: "schedule-all", enabled: true, intervalHours: 12, expectedRevision: 4 });
    await waitFor(() => expect(root.querySelector<HTMLInputElement>('.exo-agent-group input[type="checkbox"]')?.indeterminate).toBe(false));
    expect(policy.archive).toEqual({ enabled: true, intervalHours: 12 });
    expect(policy.mirror).toEqual({ enabled: true, intervalMinutes: 720 });
    const interval = root.querySelector<HTMLInputElement>('.exo-agent-group input[type="number"]');
    expect(interval).not.toBeNull();
    if (interval === null) throw new Error("Backup policy interval is missing");
    interval.focus();
    interval.value = "24";
    interval.dispatchEvent(new Event("input", { bubbles: true }));
    interval.blur();
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toMatchObject({ kind: "schedule-all", enabled: true, intervalHours: 24, expectedRevision: 5 });
    expect(policy.archive).toEqual({ enabled: true, intervalHours: 24 });
    expect(policy.mirror).toEqual({ enabled: true, intervalMinutes: 1440 });
    expect(root.textContent).not.toContain("Back up to Saturn now");
    expect(root.textContent).not.toContain("Mirror to Saturn now");
  } finally { cleanup(); }
});
