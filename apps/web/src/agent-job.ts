export type AgentJob = { id: string; state: string; message?: string };
const storageKey = "exocortex.neptune.initialization";
export function pendingAgentJob(): AgentJob | null {
  const id = window.localStorage.getItem(storageKey);
  return id && /^neptune-[0-9]+-[a-f0-9]{16}$/.test(id) ? { id, state: "REQUESTED" } : null;
}

/** Network interruptions during enrollment are retryable; acceptance is never reported as completion. */
export async function waitForAgentJob(initial: AgentJob, read: (id: string) => Promise<AgentJob>): Promise<AgentJob> {
  let job = initial;
  window.localStorage.setItem(storageKey, job.id);
  const deadline = Date.now() + 10 * 60_000;
  while (!["COMPLETED", "FAILED"].includes(job.state) && Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, 1_000));
    try { job = await read(job.id); }
    catch { /* The connected service may be restarting while enrollment completes. */ }
  }
  if (["COMPLETED", "FAILED"].includes(job.state)) window.localStorage.removeItem(storageKey);
  if (job.state === "FAILED") throw new Error(job.message || "Agent initialization failed");
  if (job.state !== "COMPLETED") throw new Error("Agent initialization is still running; reopen Settings to continue checking its status.");
  return job;
}
