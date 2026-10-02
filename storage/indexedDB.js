const DATABASE_NAME = 'PrivacyDashboardDB';
const DATABASE_VERSION = 2;
const REQUEST_STORE = 'requests';
const TRACKER_STORE = 'trackers';
const SITE_STORE = 'sites';
const MAX_REQUEST_RECORDS = 500;

let databasePromise;

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, options);
  }
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      const transaction = event.target.transaction;
      const trackers = database.objectStoreNames.contains(TRACKER_STORE)
        ? transaction.objectStore(TRACKER_STORE)
        : database.createObjectStore(TRACKER_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
      ensureIndex(trackers, 'url', 'url', { unique: true });
      ensureIndex(trackers, 'domain', 'domain');

      const requests = database.objectStoreNames.contains(REQUEST_STORE)
        ? transaction.objectStore(REQUEST_STORE)
        : database.createObjectStore(REQUEST_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
      ensureIndex(requests, 'timestamp', 'timestamp');
      ensureIndex(requests, 'domain', 'domain');
      ensureIndex(requests, 'siteDomain', 'siteDomain');
      ensureIndex(requests, 'action', 'action');
      ensureIndex(requests, 'tabId', 'tabId');

      if (!database.objectStoreNames.contains(SITE_STORE)) {
        database.createObjectStore(SITE_STORE, { keyPath: 'domain' });
      }

      const existingKeys = requests.getAllKeys();
      existingKeys.onsuccess = () => {
        const keys = existingKeys.result;
        if (keys.length > MAX_REQUEST_RECORDS) {
          for (const key of keys.slice(0, keys.length - MAX_REQUEST_RECORDS)) {
            requests.delete(key);
          }
        }
      };
    };

    request.onsuccess = (event) => {
      const database = event.target.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = (event) => {
      databasePromise = null;
      reject(event.target.error || new Error('Could not open local request storage.'));
    };

    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('Database upgrade is blocked by another open extension page.'));
    };
  });

  return databasePromise;
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storedUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function incrementActionCounts(record, action) {
  const next = { ...record, requestCount: (record.requestCount || 0) + 1 };
  if (action === 'BLOCKED') next.blockedCount = (next.blockedCount || 0) + 1;
  if (action === 'FLAGGED') next.flaggedCount = (next.flaggedCount || 0) + 1;
  if (action === 'ALLOWED') next.allowedCount = (next.allowedCount || 0) + 1;
  return next;
}

export async function initializeStorage() {
  await openDatabase();
}

export async function recordRequest(analysis, decision) {
  if (!analysis?.domain || !analysis?.siteDomain) return;

  const database = await openDatabase();
  const transaction = database.transaction(
    [REQUEST_STORE, TRACKER_STORE, SITE_STORE],
    'readwrite'
  );
  const requests = transaction.objectStore(REQUEST_STORE);
  const trackers = transaction.objectStore(TRACKER_STORE);
  const sites = transaction.objectStore(SITE_STORE);
  const action = decision?.action || 'ALLOWED';
  const trackerId = analysis.trackerId || analysis.domain;
  const requestRecord = {
    url: storedUrl(analysis.url),
    domain: analysis.domain,
    siteDomain: analysis.siteDomain,
    type: analysis.type || 'other',
    timestamp: new Date().toISOString(),
    action,
    trackerId,
    trackerName: analysis.trackerName || analysis.domain,
    company: analysis.company,
    category: analysis.category || 'Unknown',
    purpose: analysis.purpose,
    confidence: decision?.confidence ?? analysis.confidence ?? 0,
    signals: Array.isArray(decision?.signals) ? decision.signals : [],
    isTracker: Boolean(analysis.isTracker),
    policy: decision?.policy || 'ALLOW',
    reason: decision?.reason || '',
    tabId: analysis.tabId
  };

  requests.add(requestRecord);
  const keysRequest = requests.getAllKeys();
  keysRequest.onsuccess = () => {
    const keys = keysRequest.result;
    if (keys.length > MAX_REQUEST_RECORDS) {
      for (const key of keys.slice(0, keys.length - MAX_REQUEST_RECORDS)) {
        requests.delete(key);
      }
    }
  };

  const trackerRequest = trackers.index('url').get(analysis.domain);
  trackerRequest.onsuccess = () => {
    const existing = trackerRequest.result || {
      url: analysis.domain,
      name: analysis.trackerName || analysis.domain,
      domain: analysis.domain,
      requestCount: 0,
      blockedCount: 0,
      allowedCount: 0,
      flaggedCount: 0
    };
    trackers.put(incrementActionCounts({
      ...existing,
      domain: analysis.domain,
      company: analysis.company || existing.company || null,
      category: analysis.category || existing.category || 'Unknown',
      purpose: analysis.purpose || existing.purpose || null,
      trackerId
    }, action));
  };

  const siteRequest = sites.get(analysis.siteDomain);
  siteRequest.onsuccess = () => {
    const existing = siteRequest.result || {
      domain: analysis.siteDomain,
      protectionEnabled: true,
      requestCount: 0,
      blockedCount: 0,
      allowedCount: 0,
      flaggedCount: 0
    };
    sites.put(incrementActionCounts(existing, action));
  };

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Request storage transaction aborted.'));
  });
}

export async function getSiteData(domain) {
  if (!domain) return { site: null, requests: [] };

  const database = await openDatabase();
  const transaction = database.transaction([REQUEST_STORE, SITE_STORE], 'readonly');
  const requestsRequest = transaction.objectStore(REQUEST_STORE).getAll();
  const siteRequest = transaction.objectStore(SITE_STORE).get(domain);
  const [allRequests, site] = await Promise.all([
    readRequest(requestsRequest),
    readRequest(siteRequest)
  ]);

  const requests = allRequests
    .filter((request) => request.siteDomain === domain)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return { site: site || null, requests };
}

export async function getTrackerData(domain) {
  if (!domain) return null;
  const database = await openDatabase();
  const transaction = database.transaction(TRACKER_STORE, 'readonly');
  return readRequest(transaction.objectStore(TRACKER_STORE).index('url').get(domain));
}

export async function clearStatistics() {
  const database = await openDatabase();
  const storeNames = [REQUEST_STORE, TRACKER_STORE, SITE_STORE];
  for (const legacyStore of ['domains', 'requestDataTypes']) {
    if (database.objectStoreNames.contains(legacyStore)) storeNames.push(legacyStore);
  }

  const transaction = database.transaction(storeNames, 'readwrite');
  for (const name of storeNames) transaction.objectStore(name).clear();
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Storage clear aborted.'));
  });
}