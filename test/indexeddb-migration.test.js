import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';

const DATABASE_NAME = 'PrivacyDashboardDB';
const REQUEST_COUNT = 501;

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

async function createLegacyDatabase(factory, version) {
  const openRequest = factory.open(DATABASE_NAME, version);
  openRequest.onupgradeneeded = (event) => {
    const database = event.target.result;
    const trackers = database.createObjectStore('trackers', {
      keyPath: 'id',
      autoIncrement: true
    });
    trackers.createIndex('url', 'url', { unique: true });
    trackers.createIndex('name', 'name');
    if (version >= 2) trackers.createIndex('domain', 'domain');

    const requests = database.createObjectStore('requests', {
      keyPath: 'id',
      autoIncrement: true
    });
    requests.createIndex('timestamp', 'timestamp');
    requests.createIndex('initiatorDomainId', 'initiatorDomainId');
    requests.createIndex('trackerId', 'trackerId');
    requests.createIndex('requestUrl', 'requestUrl');
    requests.createIndex('blocked', 'blocked');
    if (version >= 2) {
      requests.createIndex('domain', 'domain');
      requests.createIndex('siteDomain', 'siteDomain');
      requests.createIndex('action', 'action');
      requests.createIndex('tabId', 'tabId');
    }

    database.createObjectStore('domains', { keyPath: 'id', autoIncrement: true });
    database.createObjectStore('requestDataTypes', { keyPath: 'id', autoIncrement: true });
    database.createObjectStore('legacyExtra', { keyPath: 'id', autoIncrement: true });
    if (version >= 2) database.createObjectStore('sites', { keyPath: 'domain' });
  };
  const database = await requestResult(openRequest);
  const transaction = database.transaction(
    ['trackers', 'requests', 'domains', 'requestDataTypes', 'legacyExtra'],
    'readwrite'
  );
  const trackers = transaction.objectStore('trackers');
  trackers.add({ url: 'tracker.example', name: 'Old tracker' });

  const requests = transaction.objectStore('requests');
  for (let index = 0; index < 3; index += 1) {
    requests.add({
      requestUrl: `https://legacy.example/${index}`,
      initiatorDomainId: 1,
      trackerId: 1,
      blocked: false
    });
  }
  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    requests.add({
      siteDomain: `site-${index}.example`,
      requestUrl: `https://tracker.example/${index}`,
      timestamp: new Date(index).toISOString(),
      action: 'ALLOWED'
    });
  }
  await transactionDone(transaction);
  database.close();
}

async function inspectDatabase(factory) {
  const database = await requestResult(factory.open(DATABASE_NAME));
  const schema = {
    stores: [...database.objectStoreNames].sort(),
    indexes: {}
  };

  for (const storeName of schema.stores) {
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    schema.indexes[storeName] = [...store.indexNames].sort();
  }

  const transaction = database.transaction('requests', 'readonly');
  const requests = await requestResult(transaction.objectStore('requests').getAll());
  database.close();
  return { schema, requests };
}

async function migrate(factory, suffix) {
  globalThis.indexedDB = factory;
  const storage = await import(`../storage/indexedDB.js?migration=${suffix}`);
  await storage.initializeStorage();
  return inspectDatabase(factory);
}

test('fresh installation creates the canonical v3 schema', async () => {
  const fresh = await migrate(new IDBFactory(), 'fresh');
  assert.deepEqual(fresh.schema, {
    stores: ['requests', 'sites', 'trackers'],
    indexes: {
      requests: ['action', 'domain', 'requestId', 'siteDomain', 'tabId', 'timestamp'],
      sites: ['lastSeen'],
      trackers: ['domain', 'lastSeen', 'url']
    }
  });
  assert.deepEqual(fresh.requests, []);
});

for (const version of [1, 2, 3]) {
  test(`v${version} to v4 removes legacy stores, indexes, and unusable request rows`, async () => {
    const factory = new IDBFactory();
    await createLegacyDatabase(factory, version);
    const migrated = await migrate(factory, `v${version}`);

    assert.deepEqual(migrated.schema, {
      stores: ['requests', 'sites', 'trackers'],
      indexes: {
        requests: ['action', 'domain', 'requestId', 'siteDomain', 'tabId', 'timestamp'],
        sites: ['lastSeen'],
        trackers: ['domain', 'lastSeen', 'url']
      }
    });
    assert.equal(migrated.requests.length, 500);
    assert.ok(migrated.requests.every((request) => request.siteDomain));
    assert.equal(migrated.requests[0].siteDomain, 'site-1.example');
    assert.equal(migrated.requests.at(-1).siteDomain, 'site-500.example');
  });
}