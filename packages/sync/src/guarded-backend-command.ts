import { requireDefined } from "../../contracts/src/require-defined.js";
import type { Database } from "@saturn/database";
import { BackendExecutorError, type BackendCommand, type BackendSubmitAndClaim } from "../../storage/src/durable-backend-executor.js";

type Writer = Pick<Database, "backendCommand" | "confirmsBackendRollback">
  & Partial<Pick<Database, "backendSubmitAndClaim" | "confirmsBackendSubmitClaimRollback">>;

/** Only an invocation-bound fixed Database statement can attest rollback. */
export function createGuardedBackendCommand(writer: Writer): BackendCommand {
  const origins = new WeakMap<object, { readonly raw: unknown; readonly witness: object; readonly compound: boolean }>();
  const invoke = async (command: string, identity: Parameters<BackendCommand>[1], payload: Parameters<BackendCommand>[2], compound: boolean): Promise<unknown> => {
    const witness = Object.freeze({});
    try {
      return compound
        ? await requireDefined(writer.backendSubmitAndClaim).call(writer, command, identity, payload, witness)
        : await writer.backendCommand(command, identity, payload, witness);
    } catch (raw) {
      const error = raw instanceof Error && /^[a-z_]{1,64}$/.test(raw.message)
        ? new BackendExecutorError(raw.message, { cause: raw }) : raw;
      if (typeof error === "object" && error !== null) origins.set(error, { raw, witness, compound });
      throw error;
    }
  };
  const ordinary: BackendCommand = (command, identity, payload) => invoke(command, identity, payload, false);
  const result = Object.assign(ordinary, {
    confirmedRollback(error: unknown, command: string, identity: Parameters<BackendCommand>[1], payload: Parameters<BackendCommand>[2]): boolean {
      if (typeof error !== "object" || error === null) return false;
      const origin = origins.get(error);
      if (!origin || !writer.confirmsBackendRollback(origin.raw, command, identity, payload, origin.witness)) return false;
      origins.delete(error);
      return true;
    },
  });
  if (writer.backendSubmitAndClaim && writer.confirmsBackendSubmitClaimRollback) {
    const compound: BackendSubmitAndClaim = (command, identity, payload) => invoke(command, identity, payload, true);
    return Object.assign(result, { submitAndClaim: Object.assign(compound, {
      confirmsNoCommit(error: unknown, command: string, identity: Parameters<BackendCommand>[1], payload: Parameters<BackendCommand>[2]): boolean {
        if (typeof error !== "object" || error === null) return false;
        const origin = origins.get(error);
        return !!origin?.compound && writer.confirmsBackendSubmitClaimRollback?.(origin.raw, command, identity, payload, origin.witness) === true;
      },
    }) });
  }
  return result;
}
