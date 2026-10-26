import { renderAppShell } from './render-shell.ts';

export interface Environment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
const denied = new Set(['/_headers', '/.assetsignore']);

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (denied.has(url.pathname) || url.pathname.startsWith('/.edge/'))
      return new Response(null, { status: 404 });
    if (url.pathname !== '/') return environment.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    // Fetch only the deployment's own static shell. This binding cannot access
    // a visitor's LAN and no backend URL is accepted by this renderer.
    const response = await environment.ASSETS.fetch(
      new Request(new URL('/', request.url), { method: 'GET' }),
    );
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    headers.delete('ETag');
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('X-LayerGlass-Renderer', 'edge');
    const html = renderAppShell(await response.text(), 'edge', url.searchParams.get('backend') === 'demo');
    return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
  },
};
