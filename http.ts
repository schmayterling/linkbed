import type { IncomingMessage, ServerResponse } from 'node:http';

export type HandlerRequest = IncomingMessage & { url: string; method: string; body?: unknown };

export const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

export const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
};

export async function body(req: HandlerRequest, max = 16384): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'send json.');
  let value: unknown = req.body;
  if (value === undefined) {
    let size = 0;
    const chunks: Buffer[] = [];
    // Raw HTTP request streams yield buffers when no string encoding is set.
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) throw fail(413, 'request is too large.');
      chunks.push(chunk);
    }
    try {
      // JSON.parse coerces its argument to text before parsing it.
      value = (JSON.parse as (input: string | Buffer) => unknown)(Buffer.concat(chunks));
    } catch {
      throw fail(400, 'invalid json.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > max) throw fail(413, 'request is too large.');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail(400, 'invalid json object.');
  // The guard above excludes null, arrays and non-objects, so callers can check JSON fields by name.
  return value as Record<string, unknown>;
}
