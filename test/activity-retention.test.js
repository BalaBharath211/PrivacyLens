import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';

const localValues = {};
const factory = new IDBFactory();
globalThis.indexedDB = factory;
globalThis.chrome = {
  storage: {
    onChanged: { addListener() {} },
    local: {
      async get(keys) {
        if (typeof keys === 'string') {
          return Object.hasOwn(localValues, keys) ? { [keys]: localValues[keys] } : {};
        }
        const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
        return Object.fromEntries(names
          .filter((key) => Object.hasOwn(localValues, key))
          .map((key) => [key, localValues[key]]));
      },
      async set(values) { Object.assign(localValues, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete localValues[key];
      }
    }
  }
};

const storage = await import('../storage/indexedDB.js?activity-retention');
const settings = await import('../storage/settings.js?activity-retention');
await storage.initializeStorage();

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted.'));
  });
}

async function readAll(storeName) {
  const database = await requestResult(factory.open('PrivacyDashboardDB'));
  const transaction = database.transaction(storeName, 'readonly');
  const result = await requestResult(transaction.objectStore(storeName).getAll());
  database.close();
  return result;
}

test('aggregates update lastSeen and prune expired/over-limit entries', async () => {
  const analysis = {
    url: 'https://tracker.example/pixel?id=secret',
    domain: 'tracker.example',
    siteDomain: 'visited.example',
    trackerId: 'tracker.example',
    trackerName: 'Example Tracker',
    category: 'Analytics',
    type: 'image'
  };
  await storage.recordRequest(analysis, { action: 'ALLOWED' });

  const initialSite = (await storage.getSiteData('visited.example')).site;
  const initialTracker = await storage.getTrackerData('tracker.example');
  assert.ok(Number.isFinite(Date.parse(initialSite.lastSeen)));
  assert.equal(initialSite.lastSeen, initialTracker.lastSeen);

  await storage.clearStatistics();
  const now = Date.now();
  const currentTime = new Date(now).toISOString();
  const oldTime = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const database = await requestResult(factory.open('PrivacyDashboardDB'));
  const transaction = database.transaction(['sites', 'trackers'], 'readwrite');
  const sites = transaction.objectStore('sites');
  const trackers = transaction.objectStore('trackers');

  for (let index = 0; index < 501; index += 1) {
    sites.put({ domain: `site-${index}.example`, lastSeen: currentTime });
  }
  sites.put({ domain: 'expired-site.example', lastSeen: oldTime });

  for (let index = 0; index < 1001; index += 1) {
    const domain = `tracker-${index}.example`;
    trackers.add({ url: domain, domain, lastSeen: currentTime });
  }
  trackers.add({ url: 'expired-tracker.example', domain: 'expired-tracker.example', lastSeen: oldTime });
  await transactionDone(transaction);
  database.close();

  const pruned = await storage.pruneStatistics(now);
  assert.deepEqual(pruned, { expired: 2, capped: 2 });

  const retainedSites = await readAll('sites');
  const retainedTrackers = await readAll('trackers');
  assert.equal(retainedSites.length, 500);
  assert.equal(retainedTrackers.length, 1000);
  assert.ok(retainedSites.every((record) => record.lastSeen >= oldTime));
  assert.ok(retainedTrackers.every((record) => record.lastSeen >= oldTime));
  assert.equal(retainedSites.some((record) => record.domain === 'expired-site.example'), false);
  assert.equal(retainedTrackers.some((record) => record.url === 'expired-tracker.example'), false);
});

test('clearing activity removes IndexedDB data and heuristic observations', async () => {
  await storage.recordRequest({
    url: 'https://tracker.example/pixel',
    domain: 'tracker.example',
    siteDomain: 'visited.example',
    type: 'image'
  }, { action: 'BLOCKED' });
  await chrome.storage.local.set({ heuristicObservations: { 'tracker.example': ['visited.example'] } });

  await storage.clearStatistics();
  await settings.clearHeuristicObservations();

  assert.deepEqual((await storage.getSiteData('visited.example')), {
    site: null,
    requests: []
  });
  assert.equal(await storage.getTrackerData('tracker.example'), undefined);
  assert.equal(Object.hasOwn(localValues, 'heuristicObservations'), false);
});

async function recordTestUrl(url, domain) {
  await storage.recordRequest({
    url,
    domain,
    siteDomain: 'redaction.example',
    type: 'image'
  }, { action: 'ALLOWED' });
  const { requests } = await storage.getSiteData('redaction.example');
  return requests.find((request) => request.domain === domain)?.url;
}

test('stored request URLs replace UUID path segments with :id', async () => {
  await storage.clearStatistics();
  assert.equal(
    await recordTestUrl(
      'https://tracker.example/users/550e8400-e29b-41d4-a716-446655440000/avatar?token=secret',
      'uuid-tracker.example'
    ),
    'https://tracker.example/users/:id/avatar'
  );
});

test('stored request URLs replace long hexadecimal path segments with :id', async () => {
  await storage.clearStatistics();
  assert.equal(
    await recordTestUrl(
      'https://tracker.example/session/0123456789abcdef0123456789abcdef/profile',
      'hex-tracker.example'
    ),
    'https://tracker.example/session/:id/profile'
  );
});

test('stored request URLs replace numeric path segments of six or more digits with :id', async () => {
  await storage.clearStatistics();
  assert.equal(
    await recordTestUrl(
      'https://tracker.example/orders/1234567/receipt',
      'numeric-tracker.example'
    ),
    'https://tracker.example/orders/:id/receipt'
  );
});

test('stored request URL path is truncated to 100 characters', async () => {
  await storage.clearStatistics();
  const path = `/${Array.from({ length: 20 }, (_, index) => `segment${index}`).join('/')}`;
  const storedUrl = await recordTestUrl(
    `https://tracker.example${path}?private=value#fragment`,
    'long-path-tracker.example'
  );
  assert.equal(storedUrl, `https://tracker.example${path.slice(0, 100)}`);
  assert.equal(storedUrl.slice('https://tracker.example'.length).length, 100);
});