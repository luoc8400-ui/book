export async function onRequest({ request }) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('Missing "url" query', { status: 400, headers: corsHeaders() });
  }

  let remoteUrl;
  try {
    remoteUrl = new URL(target);
    if (!['https:', 'http:'].includes(remoteUrl.protocol)) {
      throw new Error('invalid protocol');
    }
  } catch {
    return new Response('Bad "url"', { status: 400, headers: corsHeaders() });
  }

  try {
    const resp = await fetch(remoteUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/plain,*/*;q=0.8'
      }
    });
    const body = await resp.arrayBuffer();
    const type = resp.headers.get('content-type') || 'text/plain; charset=utf-8';
    return new Response(body, {
      headers: {
        ...corsHeaders(),
        'content-type': type
      }
    });
  } catch (err) {
    return new Response('Upstream fetch failed', { status: 502, headers: corsHeaders() });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache'
  };
}