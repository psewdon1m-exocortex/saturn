/** A hint only: durable SQL remains authoritative. The revision closes the
 * query-to-wait race; the timer also discovers work from other processes. */
export class BackendWakeup {
  revision = 0;
  #waiters = new Set<() => void>();
  notify(): void {
    this.revision++;
    for (const done of this.#waiters) done();
  }
  wait(observed: number, milliseconds: number): Promise<void> {
    if (observed !== this.revision) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      this.#waiters.add(done);
    });
  }
}
