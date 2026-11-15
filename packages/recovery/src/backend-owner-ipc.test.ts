import { beforeEach, expect, it, vi } from 'vitest';
import { backendOwnerProcessReporter } from './backend-owner-ipc.js';

// Mock only the reporter's module import. Never replace the test runner's global
// process object, environment, connection state or IPC send function.
const fixture = vi.hoisted(() => {
  type Callback = (error: Error | null) => void;
  type Send = (message: unknown, callback: Callback) => boolean;
  const calls: { message: unknown; callback: Callback; receiver: unknown }[] = [];
  const fakeProcess = {
    env: {} as Record<string, string | undefined>,
    connected: true,
    pid: 12345,
    send: undefined as Send | undefined,
  };
  const send = vi.fn(function (this: unknown, message: unknown, callback: Callback) {
    calls.push({ message, callback, receiver: this });
    return true;
  });
  return { fakeProcess, send, calls };
});
vi.mock('node:process', () => ({ default: fixture.fakeProcess }));

const nonce = 'a'.repeat(64);
const identity = { backendIdentity: 'synthetic-backend', generation: 'synthetic-generation', ownerId: 'synthetic-owner', fencingToken: 'synthetic-fence' };
const runnerSendDescriptor = Object.getOwnPropertyDescriptor(globalThis.process, 'send');

function reporter() {
  const result = backendOwnerProcessReporter();
  if (result === undefined) throw new Error('Expected explicitly configured reporter');
  return result;
}
function firstCall() {
  const call = fixture.calls.at(0);
  if (call === undefined) throw new Error('Expected exactly owned synthetic send');
  return call;
}
beforeEach(() => {
  fixture.fakeProcess.env = { SATURN_BACKEND_OWNER_IPC_NONCE: nonce };
  fixture.fakeProcess.connected = true;
  fixture.fakeProcess.send = fixture.send;
  fixture.send.mockReset();
  fixture.send.mockImplementation(function (this: unknown, message, callback) {
    fixture.calls.push({ message, callback, receiver: this });
    return true;
  });
  fixture.calls.length = 0;
  expect(Object.getOwnPropertyDescriptor(globalThis.process, 'send')).toEqual(runnerSendDescriptor);
});

it('remains opt-in when no nonce exists, even without a connection', () => {
  fixture.fakeProcess.env = {};
  fixture.fakeProcess.connected = false;
  fixture.fakeProcess.send = undefined;
  expect(backendOwnerProcessReporter()).toBeUndefined();
  expect(fixture.send).not.toHaveBeenCalled();
});

it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])('refuses an invalid nonce before sending (%s)', value => {
  fixture.fakeProcess.env.SATURN_BACKEND_OWNER_IPC_NONCE = value;
  expect(backendOwnerProcessReporter).toThrow('managed_owner_ipc_required');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('requires an actual send function during reporter creation', () => {
  fixture.fakeProcess.send = undefined;
  expect(backendOwnerProcessReporter).toThrow('managed_owner_ipc_required');
});

it('requires a connected channel during reporter creation', () => {
  fixture.fakeProcess.connected = false;
  expect(backendOwnerProcessReporter).toThrow('managed_owner_ipc_required');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('rechecks disconnection after reporter creation', async () => {
  const report = reporter();
  fixture.fakeProcess.connected = false;
  await expect(report(identity, 'ACTIVE')).rejects.toThrow('managed_owner_ipc_closed');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('rechecks removal of the send function after reporter creation', async () => {
  const report = reporter();
  fixture.fakeProcess.send = undefined;
  await expect(report(identity, 'ACTIVE')).rejects.toThrow('managed_owner_ipc_closed');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('does not publish STOPPED or require a channel for the ignored state', async () => {
  const report = reporter();
  fixture.fakeProcess.connected = false;
  fixture.fakeProcess.send = undefined;
  await expect(report(identity, 'STOPPED')).resolves.toBeUndefined();
  expect(fixture.send).not.toHaveBeenCalled();
});

it('preserves the receiver and exact private registration message and awaits callback delivery', async () => {
  const report = reporter();
  let settled = false;
  const pending = report(identity, 'ACTIVE').then(() => { settled = true; });
  expect(fixture.send).toHaveBeenCalledTimes(1);
  const call = firstCall();
  expect(call.receiver).toBe(fixture.fakeProcess);
  expect(call.message).toEqual({ schema: 'saturn.backend-owner-process.v1', nonce, pid: 12345, state: 'ACTIVE', identity });
  await Promise.resolve();
  expect(settled).toBe(false);
  call.callback(null);
  await pending;
  expect(settled).toBe(true);
  expect(Object.getOwnPropertyDescriptor(globalThis.process, 'send')).toEqual(runnerSendDescriptor);
});

it('preserves the callback error instead of reporting successful registration', async () => {
  const error = new Error('synthetic_ipc_refused');
  const pending = reporter()(identity, 'ACTIVE');
  const rejected = expect(pending).rejects.toBe(error);
  firstCall().callback(error);
  await rejected;
});

it('preserves synchronous send failure as an awaited rejection', async () => {
  const error = new Error('synthetic_send_threw');
  fixture.fakeProcess.send = () => { throw error; };
  await expect(reporter()(identity, 'ACTIVE')).rejects.toBe(error);
});

it('reads the current send function on each call rather than retaining an earlier channel', async () => {
  const report = reporter();
  const first = report(identity, 'ACTIVE');
  firstCall().callback(null);
  await first;
  const nextSend = vi.fn(function (this: unknown, _message: unknown, callback: (error: Error | null) => void) {
    callback(null);
    return true;
  });
  fixture.fakeProcess.send = nextSend;
  await report(identity, 'ACTIVE');
  expect(nextSend).toHaveBeenCalledTimes(1);
  expect(nextSend.mock.contexts.at(0)).toBe(fixture.fakeProcess);
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

it('does not treat backpressure as a completed delivery before the callback', async () => {
  fixture.send.mockReturnValueOnce(false);
  let settled = false;
  const pending = reporter()(identity, 'ACTIVE').then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  // The one-shot return override does not run the mock body; take the actual
  // callback argument without invoking or changing the runner's IPC function.
  const args = fixture.send.mock.calls.at(0);
  if (args === undefined) throw new Error('Expected synthetic backpressure send');
  args[1](null);
  await pending;
  expect(settled).toBe(true);
});
