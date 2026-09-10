// Replaced at build time. This manifest belongs to this exact deployment.
const version = "BUILD_VERSION";
const contentPaths = new Set(["CONTENT_PATHS"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const contentSection=['blog','projects'].find(section=>url.pathname.startsWith('/'+section+'/'));
    const missingContent = contentSection &&
      !['/'+contentSection+'/', '/'+contentSection+'/index.html'].includes(url.pathname) && !contentPaths.has(url.pathname);
    if (missingContent) url.pathname = '/404.html';
    // A new deployment must never reuse a previous deployment's URL cache entry.
    url.searchParams.set('__deployment', version);
    const headers = new Headers(request.headers);
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    const asset = await env.ASSETS.fetch(new Request(url, { method: request.method, headers }));
    const response = new Response(request.method === 'HEAD' ? null : asset.body, {
      status: missingContent ? 404 : asset.status,
      headers: asset.headers,
    });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    response.headers.set('X-Blog-Deployment', version);
    if (missingContent) response.headers.delete('Location');
    else if (response.headers.has('Location')) {
      const location = new URL(response.headers.get('Location'), request.url);
      location.searchParams.delete('__deployment');
      response.headers.set('Location', location.href);
    }
    return response;
  },
};
