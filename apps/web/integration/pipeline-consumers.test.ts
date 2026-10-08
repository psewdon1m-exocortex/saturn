import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { mountBackupPolicy as mountVolt } from "volt-backup-policy";
import { mountBackupPolicy as mountMastermind } from "mastermind-backup-policy";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it.each(["volt", "mastermind"] as const)("%s Settings edit only the selected pipeline capabilities", async service => {
  for (const profile of ["archive", "mirror", "both"] as const) {
    const archive = profile !== "mirror", mirror = profile !== "archive";
    let policy = { schema: "exocortex.backup.policy.v1", revision: 1, appliedRevision: 1, paused: false,
      archive: { available: archive, enabled: false, intervalHours: 24 }, mirror: mirror ? { enabled: false, intervalMinutes: 300 } : null,
      observed: { archive: { state: "archive-state" }, mirror: { state: "mirror-state" } } };
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        mutations.push(body);
        policy = { ...policy, revision: policy.revision + 1,
          archive: { ...policy.archive, enabled: archive && Boolean(body.enabled) },
          mirror: policy.mirror ? { ...policy.mirror, enabled: Boolean(body.enabled) } : null };
      }
      return { ok: true, json: async () => policy };
    }));
    const root = document.createElement("div"); document.body.append(root);
    const cleanup = (service === "volt" ? mountVolt : mountMastermind)(root, { service, base: "/api/neptune/policy" });
    try {
      await waitFor(() => expect(root.querySelectorAll('.exo-agent-group input[type="checkbox"]')).toHaveLength(1));
      const checkbox = root.querySelector<HTMLInputElement>('.exo-agent-group input[type="checkbox"]');
      if (!checkbox) throw new Error("Enrolled pipeline control is missing");
      const states = [...root.querySelectorAll('.exo-agent-group')].map(node => node.textContent).join(" ");
      expect(states.includes("archive-state")).toBe(archive);
      expect(states.includes("mirror-state")).toBe(mirror);
      checkbox.checked = true; checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => expect(mutations).toHaveLength(1));
      expect(mutations[0]).toMatchObject({ kind: profile === "both" ? "schedule-all" : "schedule", enabled: true });
      if (profile !== "both") expect(mutations[0]?.pipeline).toBe(profile);
    } finally { cleanup(); root.remove(); localStorage.clear(); }
  }
});
