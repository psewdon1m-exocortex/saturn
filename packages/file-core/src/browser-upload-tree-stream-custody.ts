interface ClosableHandle { close(): Promise<void> }

export interface BrowserTreeSpoolHandleCustody {
  open<H extends ClosableHandle>(start: () => Promise<H>): Promise<H>;
  close(handle: ClosableHandle): Promise<void>;
}

/** A persistent physical marker outlives a lost PostgreSQL advisory session.
 * Only confirmed closure of every opened data handle permits removing it.
 * Acquisition/release must use the exact private chunk marker; there is no
 * timeout, PID-only takeover or automatic recovery of a retained marker here. */
export async function withBrowserTreeSpoolCustody<T>(
  acquire: () => Promise<{ release(): Promise<void> }>,
  action: (custody: BrowserTreeSpoolHandleCustody) => Promise<T>,
): Promise<T> {
  const marker = await acquire();
  const handles = new Set<ClosableHandle>();
  let pending = 0;
  let finished = false;
  const custody: BrowserTreeSpoolHandleCustody = {
    async open(start) {
      if (finished) throw Error("browser_tree_spool_custody_finished");
      pending++;
      try {
        const handle = await start();
        handles.add(handle);
        return handle;
      } finally { pending--; }
    },
    async close(handle) {
      if (!handles.has(handle)) throw Error("browser_tree_spool_handle_invalid");
      await handle.close();
      handles.delete(handle);
    },
  };
  try {
    const result = await action(custody);
    if (pending !== 0 || handles.size !== 0) throw Error("browser_tree_spool_close_unconfirmed");
    return result;
  } finally {
    finished = true;
    // A rejected CLOSE or an unjoined open keeps the marker, even if its caller
    // caught the error. Never infer closure from cancellation or elapsed time.
    if (pending === 0 && handles.size === 0) await marker.release();
  }
}
