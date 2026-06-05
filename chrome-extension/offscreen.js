/**
 * Offscreen document — s'exécute dans un contexte navigateur réel (invisible,
 * pas d'onglet dans la barre), ce qui permet de faire des fetch() avec les
 * cookies leboncoin (credentials: 'include') et un vrai TLS fingerprint,
 * contrairement à un service worker bloqué par Cloudflare.
 */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== 'FETCH_LBC') return false;

  fetchAndParse(msg.url)
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: e.message }));

  return true; // réponse asynchrone
});

async function fetchAndParse(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      // Simule une navigation directe plutôt qu'un fetch programmatique
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  if (!res.ok) {
    const hint = (res.status === 403 || res.status === 503)
      ? ' — cookie Cloudflare expiré, visitez leboncoin.fr pour le renouveler'
      : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }

  const html = await res.text();

  // Cloudflare renvoie parfois un 200 avec une page de challenge
  if (
    html.includes('cf-browser-verification') ||
    html.includes('challenge-form') ||
    (html.includes('__cf_chl') && !html.includes('__NEXT_DATA__'))
  ) {
    throw new Error('Page de challenge Cloudflare reçue — cookie expiré');
  }

  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('__NEXT_DATA__ introuvable dans la réponse HTML');

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (_) {
    throw new Error('Impossible de parser __NEXT_DATA__');
  }

  const ads = data?.props?.pageProps?.searchData?.ads;
  if (!Array.isArray(ads)) throw new Error('Structure des annonces inattendue');

  return ads.map((ad) => ({
    id: String(ad.list_id),
    url: `https://www.leboncoin.fr${ad.url}`,
    title: ad.subject ?? 'Sans titre',
    price: ad.price?.[0] ?? null,
  }));
}
