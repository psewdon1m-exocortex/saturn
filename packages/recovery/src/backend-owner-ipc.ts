import process from 'node:process';
import type { ManagedBackendIdentity } from './backend-owner-process.js';

/** Opt-in private IPC registration. No PID/owner/fence is written to public logs. */
export function backendOwnerProcessReporter(): ((identity: ManagedBackendIdentity, state: 'ACTIVE' | 'STOPPED') => Promise<void>) | undefined {
  const nonce = process.env.SATURN_BACKEND_OWNER_IPC_NONCE;
  if (nonce === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(nonce) || !process.send || !process.connected) throw new Error('managed_owner_ipc_required');
  return async (identity, state) => {
    if (state !== 'ACTIVE') return;
    const send = process.send?.bind(process);
    if (!send || !process.connected) throw new Error('managed_owner_ipc_closed');
    await new Promise<void>((resolve, reject) => send({ schema: 'saturn.backend-owner-process.v1', nonce, pid: process.pid, state, identity }, error => error ? reject(error) : resolve()));
  };
}
