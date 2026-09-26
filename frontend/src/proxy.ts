import { NextResponse, type NextRequest } from 'next/server';
import { PROXY_AUTH_HEADER, isTrustedProxyRequest } from './lib/proxy-auth';

// Runs before every page, asset and server action. Only requests forwarded by
// Caddy (after its basic_auth) carry the shared secret; see lib/proxy-auth.ts.
export async function proxy(request: NextRequest) {
  if (await isTrustedProxyRequest(request.headers.get(PROXY_AUTH_HEADER), process.env.DASHBOARD_PROXY_SECRET)) {
    return NextResponse.next();
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export const config = {
  matcher: '/:path*',
};
