import assert from "node:assert/strict";
import test from "node:test";
import { collectBounded, deterministicBuffer, deterministicStream } from "../src/data.mjs";

test("deterministic stream equals a buffer generated for the same range", async () => {
  const expected = deterministicBuffer(200_000, 1234);
  const actual = await collectBounded(deterministicStream(200_000, 16_384, 1234), 200_000);
  assert.deepEqual(actual, expected);
});

test("bounded collector rejects oversized input", async () => {
  await assert.rejects(
    () => collectBounded(deterministicStream(1025, 128), 1024),
    /exceeded 1024 byte bound/,
  );
});
