// Keep the historical database name so existing user data can be migrated.
const DATABASE_NAME = 'PrivacyDashboardDB';
const DATABASE_VERSION = 4;
const REQUEST_STORE = 'requests';
const TRACKER_STORE = 'trackers';
const SITE_STORE = 'sites';
const MAX_REQUEST_RECORDS = 500;
const MAX_SITE_AGGREGATES = 500;
const MAX_TRACKER_AGGREGATES = 1_000;
const AGGREGATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let databasePromise;

function normalizeIndexes(store, definitions) {
  const expected = new Map(definitions.map(([name, keyPath, options = {}]) => [
    name,
    { keyPath, unique: Boolean(options.unique) }
  ]));

  for (const name of Array.from(store.indexNames)) {
    const definition = expected.get(name);
    const index = store.index(name);
    if (
      !definition ||
      JSON.stringify(index.keyPath) !== JSON.stringify(definition.keyPath) ||
      index.unique !== definition.unique
    ) {
      store.deleteIndex(name);
    }
  }

  for (const [name, keyPath, options] of definitions) {
    if (!store.indexNames.contains(name)) {
      store.createIndex(name, keyPath, options || {});
    }
  }
}

function pruneLegacyRequests(requests) {
  const cursorRequest = requests.openCursor();
  const retainedKeys = [];

  cursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) {
      const excess = retainedKeys.length - MAX_REQUEST_RECORDS;
      for (const key of retainedKeys.slice(0, Math.max(0, excess))) {
        requests.delete(key);
      }
      return;
    }

    if (typeof cursor.value?.siteDomain !== 'string' || !cursor.value.siteDomain) {
      cursor.delete();
    } else {
      retainedKeys.push(cursor.primaryKey);
    }
    cursor.continue();
  };
}

function backfillLastSeen(store, fallbackTimestamp) {
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) return;

    if (!Number.isFinite(Date.parse(cursor.value.lastSeen))) {
      cursor.update({ ...cursor.value, lastSeen: fallbackTimestamp });
    }
    cursor.continue();
  };
}

function pruneAggregateStore(store, cutoff, maximumRecords, totals) {
  const retained = [];
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (!cursor) {
      retained.sort((left, right) => left.lastSeen.localeCompare(right.lastSeen));
      const excess = retained.length - maximumRecords;
      for (const record of retained.slice(0, Math.max(0, excess))) {
        store.delete(record.key);
        totals.capped += 1;
      }
      return;
    }

    const lastSeen = cursor.value.lastSeen;
    if (!Number.isFinite(Date.parse(lastSeen)) || lastSeen < cutoff) {
      cursor.delete();
      totals.expired += 1;
    } else {
      retained.push({ key: cursor.primaryKey, lastSeen });
    }
    cursor.continue();
  };
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      const transaction = event.target.transaction;
      const allowedStores = new Set([REQUEST_STORE, TRACKER_STORE, SITE_STORE]);
      for (const storeName of Array.from(database.objectStoreNames)) {
        if (!allowedStores.has(storeName)) database.deleteObjectStore(storeName);
      }

      const trackers = database.objectStoreNames.contains(TRACKER_STORE)
        ? transaction.objectStore(TRACKER_STORE)
        : database.createObjectStore(TRACKER_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
      normalizeIndexes(trackers, [
        ['url', 'url', { unique: true }],
        ['domain', 'domain'],
        ['lastSeen', 'lastSeen']
      ]);

      const requests = database.objectStoreNames.contains(REQUEST_STORE)
        ? transaction.objectStore(REQUEST_STORE)
        : database.createObjectStore(REQUEST_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
      normalizeIndexes(requests, [
        ['timestamp', 'timestamp'],
        ['domain', 'domain'],
        ['siteDomain', 'siteDomain'],
        ['action', 'action'],
        ['tabId', 'tabId'],
        ['requestId', 'requestId']
      ]);

      const sites = database.objectStoreNames.contains(SITE_STORE)
        ? transaction.objectStore(SITE_STORE)
        : database.createObjectStore(SITE_STORE, { keyPath: 'domain' });
      normalizeIndexes(sites, [['lastSeen', 'lastSeen']]);

      if (event.oldVersion < DATABASE_VERSION) {
        const migratedAt = new Date().toISOString();
        backfillLastSeen(trackers, migratedAt);
        backfillLastSeen(sites, migratedAt);
      }

      if (event.oldVersion < DATABASE_VERSION) pruneLegacyRequests(requests);
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
    const redactedPath = url.pathname
      .split('/')
      .map((segment) => {
        if (
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(segment) ||
          /^[0-9a-f]{16,}$/i.test(segment) ||
          /^\d{6,}$/.test(segment)
        ) {
          return ':id';
        }
        return segment;
      })
      .join('/')
      .slice(0, 100);
    return `${url.origin}${redactedPath}`;
  } catch {
    return '';
  }
}

function incrementActionCounts(record, action, lastSeen) {
  const next = {
    ...record,
    requestCount: (record.requestCount || 0) + 1,
    lastSeen
  };
  if (action === 'BLOCKED') next.blockedCount = (next.blockedCount || 0) + 1;
  if (action === 'possibleBlock') next.possibleBlockCount = (next.possibleBlockCount || 0) + 1;
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
  const lastSeen = new Date().toISOString();
  const requestRecord = {
    url: storedUrl(analysis.url),
    domain: analysis.domain,
    siteDomain: analysis.siteDomain,
    type: analysis.type || 'other',
    timestamp: lastSeen,
    action,
    trackerId,
    trackerName: analysis.trackerName || analysis.domain,
    serviceType: analysis.serviceType || null,
    company: analysis.company,
    category: analysis.category || 'Unknown',
    purpose: analysis.purpose,
    confidence: decision?.confidence ?? analysis.confidence ?? 0,
    signals: Array.isArray(decision?.signals) ? decision.signals : [],
    isTracker: Boolean(analysis.isTracker),
    policy: decision?.policy || 'ALLOW',
    reason: decision?.reason || '',
    tabId: analysis.tabId,
    requestId: analysis.requestId
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
      possibleBlockCount: 0,
      flaggedCount: 0,
      lastSeen
    };
    trackers.put(incrementActionCounts({
      ...existing,
      domain: analysis.domain,
      company: analysis.company || existing.company || null,
      category: analysis.category || existing.category || 'Unknown',
      purpose: analysis.purpose || existing.purpose || null,
      trackerId
    }, action, lastSeen));
  };

  const siteRequest = sites.get(analysis.siteDomain);
  siteRequest.onsuccess = () => {
    const existing = siteRequest.result || {
      domain: analysis.siteDomain,
      protectionEnabled: true,
      requestCount: 0,
      blockedCount: 0,
      allowedCount: 0,
      possibleBlockCount: 0,
      flaggedCount: 0,
      lastSeen
    };
    sites.put(incrementActionCounts(existing, action, lastSeen));
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

export async function pruneStatistics(now = Date.now()) {
  const database = await openDatabase();
  const transaction = database.transaction([TRACKER_STORE, SITE_STORE], 'readwrite');
  const cutoff = new Date(now - AGGREGATE_RETENTION_MS).toISOString();
  const totals = { expired: 0, capped: 0 };

  pruneAggregateStore(
    transaction.objectStore(SITE_STORE),
    cutoff,
    MAX_SITE_AGGREGATES,
    totals
  );
  pruneAggregateStore(
    transaction.objectStore(TRACKER_STORE),
    cutoff,
    MAX_TRACKER_AGGREGATES,
    totals
  );

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Aggregate pruning transaction aborted.'));
  });
  return totals;
}

function decrementPossibleBlocks(record, count) {
  return {
    ...record,
    possibleBlockCount: Math.max(0, (record.possibleBlockCount || 0) - count),
    blockedCount: (record.blockedCount || 0) + count
  };
}

async function upgradePossibleBlocks(indexName, indexValue, maximumCount) {
  if (maximumCount <= 0 || indexValue == null) return 0;

  const database = await openDatabase();
  const transaction = database.transaction(
    [REQUEST_STORE, TRACKER_STORE, SITE_STORE],
    'readwrite'
  );
  const requests = transaction.objectStore(REQUEST_STORE);
  const trackerStore = transaction.objectStore(TRACKER_STORE);
  const siteStore = transaction.objectStore(SITE_STORE);
  let upgradedCount = 0;

  const matchingRequests = requests.index(indexName).getAll(indexValue);
  matchingRequests.onsuccess = () => {
    const candidates = matchingRequests.result
      .filter((request) => request.action === 'possibleBlock')
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, maximumCount);
    const siteDeltas = new Map();
    const trackerDeltas = new Map();

    for (const request of candidates) {
      requests.put({
        ...request,
        action: 'BLOCKED',
        policy: 'BLOCK',
        reason: 'A PrivacyLens DNR rule matched for this tab during confirmation.'
      });
      if (request.siteDomain) {
        siteDeltas.set(request.siteDomain, (siteDeltas.get(request.siteDomain) || 0) + 1);
      }
      if (request.domain) {
        trackerDeltas.set(request.domain, (trackerDeltas.get(request.domain) || 0) + 1);
      }
    }

    for (const [domain, count] of siteDeltas) {
      const siteRequest = siteStore.get(domain);
      siteRequest.onsuccess = () => {
        if (siteRequest.result) siteStore.put(decrementPossibleBlocks(siteRequest.result, count));
      };
    }

    for (const [domain, count] of trackerDeltas) {
      const trackerRequest = trackerStore.index('url').get(domain);
      trackerRequest.onsuccess = () => {
        if (trackerRequest.result) {
          trackerStore.put(decrementPossibleBlocks(trackerRequest.result, count));
        }
      };
    }

    upgradedCount = candidates.length;
  };

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Block confirmation transaction aborted.'));
  });
  return upgradedCount;
}

export async function upgradePossibleBlock(requestId) {
  if (requestId == null) return 0;
  return upgradePossibleBlocks('requestId', requestId, 1);
}