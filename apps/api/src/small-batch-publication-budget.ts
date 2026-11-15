/** Shared by all batch requests. Waiting parts are bounded by the HTTP request
 * limit and each receiver's four-part window, including interrupted requests. */
export class SmallBatchPublicationBudget {
  constructor(private readonly maximum = 4) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) throw Error("Invalid batch publication budget");
  }
  #active = 0;
  #waiting: (() => void)[] = [];
  async run(action: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.#active >= this.maximum) await new Promise<void>(resolve => this.#waiting.push(resolve));
    else this.#active++;
    try { signal?.throwIfAborted(); await action(); }
    finally {
      const next = this.#waiting.shift();
      if (next) next(); else this.#active--;
    }
  }
}
