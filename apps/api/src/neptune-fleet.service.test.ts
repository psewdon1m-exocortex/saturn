import { describe, expect, it } from "vitest";
import { updateCommandJob, type CommandRow } from "./neptune-fleet.service.js";

describe("remote update status", () => {
  const command: CommandRow = { id: "command", kind: "agent.update", payload: { version: "0.1.8" }, state: "pending", error: null, created_at: new Date(), completed_at: null };
  it("waits for the selected running version and reports actual errors", () => {
    expect(updateCommandJob(command).state).toBe("WAITING_FOR_AGENT");
    expect(updateCommandJob({ ...command, state: "succeeded" }).state).toBe("COMPLETED");
    expect(updateCommandJob({ ...command, state: "failed", error: "Signature rejected" }).message).toBe("Signature rejected");
    expect(updateCommandJob({ ...command, created_at: new Date(Date.now() - 8 * 86400000) }).state).toBe("FAILED");
  });
});
