let trackerCatalog = {};
let sortedTrackerEntries = [];

export async function initializeTrackerDB() {
  if (Object.keys(trackerCatalog).length > 0) return;

  const response = await fetch(chrome.runtime.getURL('tracker-db/trackers.json'));
  if (!response.ok) {
    throw new Error(`Could not load tracker catalog (${response.status})`);
  }

  trackerCatalog = await response.json();
  sortedTrackerEntries = Object.entries(trackerCatalog).sort(
    ([left], [right]) => right.length - left.length
  );
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || !value) return null;

  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function domainMatches(hostname, pattern) {
  const normalizedPattern = pattern.replace(/^\*\./, '').toLowerCase();
  return hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`);
}

export function findTracker(domain, url = '') {
  const hostname = normalizeHostname(domain);
  if (!hostname) return null;

  const match = sortedTrackerEntries.find(([pattern]) =>
    domainMatches(hostname, pattern)
  );

  if (!match) return null;
  const [pattern, record] = match;
  return { id: pattern, domain: pattern, ...record, url };
}

export function getTrackerCatalog() {
  return Object.entries(trackerCatalog).map(([domain, tracker]) => ({
    id: domain,
    domain,
    ...tracker
  }));
}