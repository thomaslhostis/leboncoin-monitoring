/**
 * Offscreen document — s'exécute dans un contexte navigateur réel (invisible,
 * pas d'onglet dans la barre), ce qui permet de faire des fetch() avec les
 * cookies leboncoin (credentials: 'include') et un vrai TLS fingerprint,
 * contrairement à un service worker bloqué par Cloudflare.
 */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'FETCH_LBC') {
    fetchAndParse(msg.url)
      .then((data) => reply({ ok: true, data }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true; // réponse asynchrone
  }

  if (msg.type === 'PLAY_QUACK') {
    playQuack();
    reply({ ok: true });
    return false;
  }

  return false;
});

// ── Audio ─────────────────────────────────────────────────────────────────────

let audioCtx = null;
let quackBuffer = null;

async function getQuackBuffer() {
  if (quackBuffer) return quackBuffer;
  if (!audioCtx) audioCtx = new AudioContext();
  const response = await fetch('sounds/quack.wav');
  const arrayBuffer = await response.arrayBuffer();
  quackBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return quackBuffer;
}

async function playQuack() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const buffer = await getQuackBuffer();

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1.15; // légèrement plus aigu

    const gain = audioCtx.createGain();
    gain.gain.value = 0.6; // légèrement atténué

    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.start();
  } catch (e) {
    console.warn('[audio] playQuack failed', e);
  }
}

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
