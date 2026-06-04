const KEY_MONITORS = 'monitors';
const KEY_SNAPSHOTS = 'snapshots';
const KEY_NOTIF = 'notif_urls'; // maps notifId → URL to open on click

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(recreateAlarms);
chrome.runtime.onStartup.addListener(recreateAlarms);

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => checkPage(alarm.name));

async function recreateAlarms() {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  await chrome.alarms.clearAll();
  for (const m of monitors) {
    if (m.enabled !== false) {
      chrome.alarms.create(m.id, { periodInMinutes: m.frequency, delayInMinutes: 0.1 });
    }
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

chrome.notifications.onClicked.addListener(async (notifId) => {
  chrome.notifications.clear(notifId);
  const { [KEY_NOTIF]: notifUrls = {} } = await chrome.storage.local.get(KEY_NOTIF);
  const url = notifUrls[notifId];
  if (url) {
    try {
      await chrome.tabs.create({ url });
    } catch (e) {
      if (e.message && e.message.toLowerCase().includes('no current window')) {
        await chrome.windows.create({ url, focused: true });
      }
    }
    delete notifUrls[notifId];
    await chrome.storage.local.set({ [KEY_NOTIF]: notifUrls });
  }
});

// ── Messages from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    ADD_MONITOR:      () => addMonitor(msg.monitor),
    REMOVE_MONITOR:   () => removeMonitor(msg.monitorId),
    TOGGLE_MONITOR:   () => toggleMonitor(msg.monitorId, msg.enabled),
    UPDATE_FREQUENCY: () => updateFrequency(msg.monitorId, msg.frequency),
    CHECK_NOW:        () => checkPage(msg.monitorId),
  };
  const fn = handlers[msg.type];
  if (!fn) return;
  fn().then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: e.message }));
  return true; // async response
});

// ── CRUD helpers ──────────────────────────────────────────────────────────────

async function addMonitor(monitor) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  if (monitors.some((m) => m.url === monitor.url)) throw new Error('URL déjà surveillée');
  monitors.push(monitor);
  await chrome.storage.local.set({ [KEY_MONITORS]: monitors });
  chrome.alarms.create(monitor.id, { periodInMinutes: monitor.frequency });
  // Déclenche immédiatement le premier check sans attendre l'alarme
  // (le service worker peut se mettre en veille avant que l'alarme de 6s fire)
  checkPage(monitor.id);
}

async function removeMonitor(monitorId) {
  const { monitors = [], [KEY_SNAPSHOTS]: snapshots = {} } = await chrome.storage.local.get([
    KEY_MONITORS,
    KEY_SNAPSHOTS,
  ]);
  await chrome.storage.local.set({
    [KEY_MONITORS]: monitors.filter((m) => m.id !== monitorId),
    [KEY_SNAPSHOTS]: Object.fromEntries(Object.entries(snapshots).filter(([k]) => k !== monitorId)),
  });
  chrome.alarms.clear(monitorId);
}

async function toggleMonitor(monitorId, enabled) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const updated = monitors.map((m) => (m.id === monitorId ? { ...m, enabled } : m));
  await chrome.storage.local.set({ [KEY_MONITORS]: updated });
  if (enabled) {
    const monitor = updated.find((m) => m.id === monitorId);
    chrome.alarms.create(monitorId, { periodInMinutes: monitor.frequency, delayInMinutes: 0.1 });
  } else {
    chrome.alarms.clear(monitorId);
  }
}

async function updateFrequency(monitorId, frequency) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const updated = monitors.map((m) => (m.id === monitorId ? { ...m, frequency } : m));
  await chrome.storage.local.set({ [KEY_MONITORS]: updated });
  // Recrée l'alarme avec la nouvelle fréquence si le monitor est actif
  const monitor = updated.find((m) => m.id === monitorId);
  if (monitor && monitor.enabled !== false) {
    await chrome.alarms.clear(monitorId);
    chrome.alarms.create(monitorId, { periodInMinutes: frequency, delayInMinutes: 0.1 });
  }
}

// ── Page checking ─────────────────────────────────────────────────────────────

async function checkPage(monitorId) {
  const { monitors = [] } = await chrome.storage.local.get(KEY_MONITORS);
  const monitor = monitors.find((m) => m.id === monitorId);
  if (!monitor || monitor.enabled === false) return;

  const now = Date.now();
  let patch;

  try {
    const ads = await fetchLeboncoinAds(monitor.url);

    const { [KEY_SNAPSHOTS]: snapshots = {} } = await chrome.storage.local.get(KEY_SNAPSHOTS);
    const prev = snapshots[monitorId];
    const prevIds = prev?.ids ?? [];
    const isFirstCheck = !prev;

    if (isFirstCheck) {
      // Première vérification : juste confirmer que la surveillance est active
      await sendNotification(
        monitor.id,
        `✅ Surveillance activée`,
        monitor.name,
        monitor.url,
      );
    } else {
      const newAds = ads.filter((ad) => !prevIds.includes(ad.id));
      if (newAds.length > 0) {
        const message =
          newAds.length === 1
            ? `${newAds[0].title}${newAds[0].price != null ? ` — ${newAds[0].price} €` : ''}`
            : `${newAds.length} nouvelles annonces`;
        // Toujours ouvrir la page de recherche au clic
        await sendNotification(monitor.id, `🔔 ${monitor.name}`, message, monitor.url);
      }
    }

    snapshots[monitorId] = { ids: ads.map((a) => a.id), updatedAt: now };
    await chrome.storage.local.set({ [KEY_SNAPSHOTS]: snapshots });

    patch = { lastCheck: now, lastCount: ads.length, lastError: null };
  } catch (err) {
    patch = { lastCheck: now, lastError: err.message };
  }

  const { monitors: fresh = [] } = await chrome.storage.local.get(KEY_MONITORS);
  await chrome.storage.local.set({
    [KEY_MONITORS]: fresh.map((m) => (m.id === monitorId ? { ...m, ...patch } : m)),
  });
}

async function sendNotification(monitorId, title, message, targetUrl) {
  // ID unique par notification pour éviter qu'une notification existante bloque l'affichage
  const notifId = `notif-${monitorId}-${Date.now()}`;
  const { [KEY_NOTIF]: notifUrls = {} } = await chrome.storage.local.get(KEY_NOTIF);
  notifUrls[notifId] = targetUrl;
  await chrome.storage.local.set({ [KEY_NOTIF]: notifUrls });

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
    requireInteraction: false,
  });
}

// ── Leboncoin fetching ────────────────────────────────────────────────────────
// Stratégie en cascade :
//  1. Injection dans un onglet leboncoin.fr déjà ouvert (world:MAIN → same-origin,
//     Sec-Fetch-Site:same-origin → passe Cloudflare sans ouvrir de nouvel onglet).
//  2. Offscreen document (peut fonctionner si __cf_clearance encore valide).
//  3. Onglet en arrière-plan (filet de sécurité, toujours fonctionnel).

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Parsing leboncoin search results HTML without a visible tab',
  });
}

async function fetchLeboncoinAds(url) {
  // ── Tentative 1 : onglet leboncoin existant (aucun nouvel onglet) ─────────
  try {
    const data = await fetchViaSameOriginTab(url);
    if (data) return data;
  } catch (e) {
    console.warn('[LBC] same-origin tab échoué :', e.message);
  }

  // ── Tentative 2 : offscreen document ─────────────────────────────────────
  try {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_LBC', url });
    if (result?.ok && result.data) return result.data;
    throw new Error(result?.error ?? 'Réponse invalide du document offscreen');
  } catch (e) {
    console.warn('[LBC] offscreen échoué :', e.message);
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }

  // ── Tentative 3 : onglet en arrière-plan (fallback garanti) ───────────────
  return fetchLeboncoinAdsViaTab(url);
}

/**
 * Injecte une iframe invisible dans un onglet leboncoin.fr déjà ouvert.
 * La navigation iframe est same-origin (leboncoin → leboncoin) :
 *   - Sec-Fetch-Mode: navigate / Sec-Fetch-Site: same-origin → passe Cloudflare
 *   - Les deux documents étant same-origin, on peut lire iframe.contentDocument
 * Aucun nouvel onglet n'est créé.
 */
async function fetchViaSameOriginTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://www.leboncoin.fr/*' });
  if (tabs.length === 0) return null;

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: 'MAIN',
    func: (targetUrl) => {
      return new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;visibility:hidden;pointer-events:none;';

        const cleanup = () => { try { document.body.removeChild(iframe); } catch (_) {} };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 25_000);

        iframe.onload = () => {
          clearTimeout(timer);
          try {
            const el = iframe.contentDocument && iframe.contentDocument.getElementById('__NEXT_DATA__');
            if (!el) { cleanup(); resolve(null); return; }
            const data = JSON.parse(el.textContent);
            const ads = data && data.props && data.props.pageProps && data.props.pageProps.searchData && data.props.pageProps.searchData.ads;
            if (!Array.isArray(ads)) { cleanup(); resolve(null); return; }
            const parsed = ads.map(function(ad) {
              return {
                id: String(ad.list_id),
                url: 'https://www.leboncoin.fr' + ad.url,
                title: ad.subject || 'Sans titre',
                price: (ad.price && ad.price[0]) != null ? ad.price[0] : null,
              };
            });
            cleanup();
            resolve(parsed);
          } catch (_) {
            cleanup();
            resolve(null);
          }
        };

        iframe.onerror = function() { clearTimeout(timer); cleanup(); resolve(null); };
        iframe.src = targetUrl;
        document.body.appendChild(iframe);
      });
    },
    args: [url],
  });

  return result?.result ?? null;
}

async function fetchLeboncoinAdsViaTab(url) {
  let tabId = null;
  let windowId = null;
  try {
    // Si aucune fenêtre n'est ouverte, chrome.tabs.create lève "No current window".
    // On utilise alors chrome.windows.create pour créer une fenêtre minimisée.
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      if (e.message && e.message.toLowerCase().includes('no current window')) {
        const win = await chrome.windows.create({ url, state: 'minimized', focused: false });
        tab = win.tabs[0];
        windowId = win.id;
      } else {
        throw e;
      }
    }
    tabId = tab.id;

    await waitForTabComplete(tabId, 30_000);

    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractLeboncoinDataFromPage,
    });

    const data = result?.result;
    if (!data) throw new Error('Impossible de lire les données leboncoin (page inattendue ?)');

    return data;
  } finally {
    // Fermer la fenêtre entière si on en a créé une, sinon juste l'onglet
    if (windowId !== null) {
      chrome.windows.remove(windowId).catch(() => {});
    } else if (tabId !== null) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

/** Attend que l'onglet atteigne le statut "complete" ou lève une erreur en cas de timeout. */
async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Onglet fermé de manière inattendue');
    if (tab.status === 'complete') return;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('Timeout de chargement de la page (30 s)');
}

/**
 * Fonction injectée dans l'onglet leboncoin (fallback uniquement).
 * Lit __NEXT_DATA__ et retourne le tableau des annonces normalisées.
 * IMPORTANT : cette fonction s'exécute dans le contexte de la page,
 * pas dans celui de l'extension — pas d'accès aux API chrome ici.
 */
function extractLeboncoinDataFromPage() {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return null;

  let data;
  try {
    data = JSON.parse(el.textContent);
  } catch (_) {
    return null;
  }

  const ads = data?.props?.pageProps?.searchData?.ads;
  if (!Array.isArray(ads)) return null;

  return ads.map((ad) => ({
    id: String(ad.list_id),
    url: `https://www.leboncoin.fr${ad.url}`,
    title: ad.subject ?? 'Sans titre',
    price: ad.price?.[0] ?? null,
  }));
}
