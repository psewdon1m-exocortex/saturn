import { Readable, Transform } from "node:stream";

export function fillDeterministic(buffer, absoluteOffset = 0) {
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = ((absoluteOffset + index) * 31 + 17) % 251;
  }
  return buffer;
}

export function deterministicBuffer(length, absoluteOffset = 0) {
  return fillDeterministic(Buffer.allocUnsafe(length), absoluteOffset);
}

export function deterministicStream(totalBytes, chunkBytes, startOffset = 0) {
  let emitted = 0;
  return new Readable({
    highWaterMark: chunkBytes,
    read() {
      if (emitted >= totalBytes) {
        this.push(null);
        return;
      }
      const length = Math.min(chunkBytes, totalBytes - emitted);
      const chunk = deterministicBuffer(length, startOffset + emitted);
      emitted += length;
      this.push(chunk);
    },
  });
}

export function hashingTransform(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

export async function collectBounded(readable, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of readable) {
    total += chunk.length;
    if (total > maximumBytes) {
      readable.destroy(new Error(`Read exceeded ${maximumBytes} byte bound`));
      throw new Error(`Read exceeded ${maximumBytes} byte bound`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
