import type { NestFastifyApplication } from '@nestjs/platform-fastify';

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

interface RequestResult {
  statusCode: number;
  body: any;
}

// Uses Fastify's built-in .inject() — an in-process fake request that goes
// through the real routing/guard/pipe/controller/service stack without
// binding an actual TCP port. This is the standard way to test a
// Nest+Fastify app at the HTTP layer.
export async function request(app: NestFastifyApplication, opts: RequestOptions): Promise<RequestResult> {
  const res = await app.getHttpAdapter().getInstance().inject({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    payload: opts.payload as any,
  });

  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.payload;
  }
  return { statusCode: res.statusCode, body };
}
