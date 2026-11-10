// Chrome native messaging framing: each message is a 4-byte little-endian length + UTF-8 JSON.

export function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > 1024 * 1024) throw new Error('Message to Chrome exceeds the 1 MB native messaging limit');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Returns a push(chunk) function that calls onMessage for every complete frame. */
export function createDecoder(onMessage, onError = () => {}) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) {
        onError(new Error(`Refusing oversized message (${len} bytes)`));
        buf = Buffer.alloc(0);
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (e) {
        onError(e);
      }
    }
  };
}
