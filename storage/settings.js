export const DEFAULT_SETTINGS = Object.freeze({
  globalProtection: true,
  protectionLevel: 'balanced',
  heuristicDetection: true,
  allowlistedSites: [],
  globalAllowlist: [],
  blocklist: [],
  sites: {}
});

let settingsCache;
let observationsCache;
let observationsQueue = Promise.resolve();

if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(DEFAULT_SETTINGS).some((key) => changes[key])) settingsCache = null;
    if (changes.heuristicObservations) observationsCache = null;
  });
}

function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  try {
    const candidate = value.trim().toLowerCase()
      .replace(/^\|\|?/, '')
      .replace(/\^.*$/, '')
      .replace(/^\*\./, '');
    const url = candidate.includes('://')
      ? new URL(candidate)
      : new URL(`https://${candidate}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function normalizeDomainList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeHostname).filter(Boolean))];
}

export async function getSettings() {
  if (settingsCache) {
    return { ...settingsCache, sites: { ...settingsCache.sites } };
  }

  const stored = await chrome.storage.local.get([
    ...Object.keys(DEFAULT_SETTINGS),
    'isHeuristicEngineEnabled',
    'allowlist',
    'settings'
  ]);

  const legacySettings = stored.settings || {};
  const heuristicDetection = typeof stored.heuristicDetection === 'boolean'
    ? stored.heuristicDetection
    : typeof stored.isHeuristicEngineEnabled === 'boolean'
      ? stored.isHeuristicEngineEnabled
      : typeof legacySettings.heuristicBlocking === 'boolean'
        ? legacySettings.heuristicBlocking
        : DEFAULT_SETTINGS.heuristicDetection;
  const globalProtection = typeof stored.globalProtection === 'boolean'
    ? stored.globalProtection
    : typeof legacySettings.blockTrackers === 'boolean'
      ? legacySettings.blockTrackers
      : DEFAULT_SETTINGS.globalProtection;

  settingsCache = {
    globalProtection,
    protectionLevel: stored.protectionLevel === 'strict' ? 'strict' : 'balanced',
    heuristicDetection,
    allowlistedSites: normalizeDomainList(stored.allowlistedSites),
    globalAllowlist: normalizeDomainList(
      Array.isArray(stored.globalAllowlist) && stored.globalAllowlist.length
        ? stored.globalAllowlist
        : stored.allowlist
    ),
    blocklist: normalizeDomainList(stored.blocklist),
    sites: stored.sites && typeof stored.sites === 'object' && !Array.isArray(stored.sites)
      ? stored.sites
      : {}
  };
  return { ...settingsCache, sites: { ...settingsCache.sites } };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    sites: patch.sites ? { ...current.sites, ...patch.sites } : current.sites
  };
  await chrome.storage.local.set(next);
  settingsCache = next;
  return next;
}

export async function setSiteProtection(domain, enabled) {
  const settings = await getSettings();
  const site = settings.sites[domain] || {};
  return updateSettings({
    sites: { [domain]: { ...site, protectionEnabled: Boolean(enabled) } }
  });
}

export async function setSiteTrackerException(siteDomain, trackerDomain, allowed) {
  const settings = await getSettings();
  const site = settings.sites[siteDomain] || {};
  const allowedTrackers = new Set(site.allowedTrackers || []);
  if (allowed) allowedTrackers.add(trackerDomain);
  else allowedTrackers.delete(trackerDomain);

  return updateSettings({
    sites: {
      [siteDomain]: { ...site, allowedTrackers: [...allowedTrackers] }
    }
  });
}

export async function observeThirdParty(domain, siteDomain) {
  if (!domain || !siteDomain) return 0;
  const operation = observationsQueue.then(async () => {
    if (!observationsCache) {
      const { heuristicObservations = {} } = await chrome.storage.local.get('heuristicObservations');
      observationsCache = heuristicObservations;
    }

    const sites = observationsCache[domain] || [];
    if (sites.includes(siteDomain)) return sites.length;

    const boundedSites = [...sites, siteDomain].slice(-20);
    if (!observationsCache[domain] && Object.keys(observationsCache).length >= 300) {
      delete observationsCache[Object.keys(observationsCache)[0]];
    }
    observationsCache[domain] = boundedSites;
    await chrome.storage.local.set({ heuristicObservations: observationsCache });
    return boundedSites.length;
  });
  observationsQueue = operation.catch(() => {});
  return operation;
}

export async function clearHeuristicObservations() {
  const operation = observationsQueue.then(async () => {
    await chrome.storage.local.remove('heuristicObservations');
    observationsCache = {};
  });
  observationsQueue = operation.catch(() => {});
  return operation;
}

