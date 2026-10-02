import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const localData = {};
let dynamicRules = [];
const rulesetChanges = [];

globalThis.chrome = {
  runtime: {
    getURL(resource) {
      return pathToFileURL(path.resolve(process.cwd(), resource)).href;
    }
  },
  storage: {
    local: {
      async get(keys) {
        const requestedKeys = Array.isArray(keys) ? keys : Object.keys(keys || {});
        return Object.fromEntries(requestedKeys
          .filter((key) => Object.hasOwn(localData, key))
          .map((key) => [key, localData[key]]));
      },
      async set(values) { Object.assign(localData, values); },
      async remove(keys) { for (const key of keys) delete localData[key]; }
    }
  },
  declarativeNetRequest: {
    async updateEnabledRulesets(change) { rulesetChanges.push(change); },
    async getDynamicRules() { return dynamicRules; },
    async updateDynamicRules(change) {
      const removeIds = new Set(change.removeRuleIds || []);
      dynamicRules = dynamicRules.filter((rule) => !removeIds.has(rule.id));
      dynamicRules.push(...(change.addRules || []));
    }
  }
};

globalThis.fetch = async (url) => {
  const contents = await readFile(fileURLToPath(url), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(contents) };
};

const { initializeTrackerDB } = await import('../tracker-db/tracker-db.js');
await initializeTrackerDB();
const { analyzeRequest } = await import('../background/request-analyzer.js');
const { classifyHeuristic } = await import('../background/heuristic-tracker-detection.js');
const { decideRequest } = await import('../background/risk-engine.js');
const { synchronizeRules } = await import('../background/rule-manager.js');
const { getSettings } = await import('../storage/settings.js');

test('analyzer identifies trackers, services, first-party requests, and malformed URLs', () => {
  const knownTracker = analyzeRequest({
    url: 'https://www.google-analytics.com/g/collect',
    initiator: 'https://shop.example.co.uk/page',
    type: 'xmlhttprequest',
    tabId: 3
  });
  assert.equal(knownTracker.isThirdParty, true);
  assert.equal(knownTracker.isTracker, true);
  assert.equal(knownTracker.category, 'Analytics');
  assert.equal(knownTracker.siteDomain, 'example.co.uk');
  assert.equal(knownTracker.tabId, 3);

  const service = analyzeRequest({
    url: 'https://cdn.jsdelivr.net/npm/library.js',
    initiator: 'https://example.com/'
  });
  assert.equal(service.isTracker, false);
  assert.equal(service.serviceType, 'service');
  assert.equal(service.category, 'CDN');

  const firstParty = analyzeRequest({
    url: 'https://static.example.com/app.js',
    initiator: 'https://www.example.com/'
  });
  assert.equal(firstParty.isThirdParty, false);

  const malformed = analyzeRequest({ url: 'not a url', initiator: null });
  assert.equal(malformed.domain, null);
  assert.equal(malformed.isThirdParty, false);
});

test('heuristics flag suspicious unknown traffic without converting it into a block', () => {
  const analysis = analyzeRequest({
    url: 'https://unknown.example/collect?client_id=abc',
    initiator: 'https://news.example/article',
    type: 'xmlhttprequest'
  });
  const heuristic = classifyHeuristic(analysis, 3);
  assert.equal(heuristic.classification, 'LIKELY');
  assert.ok(heuristic.confidence > 0.7);

  const decision = decideRequest(analysis, { globalProtection: true }, heuristic);
  assert.equal(decision.action, 'FLAGGED');
  assert.equal(decision.policy, 'FLAG');
});

test('policy distinguishes a DNR block match from a completed known-tracker request', () => {
  const analysis = analyzeRequest({
    url: 'https://google-analytics.com/collect',
    initiator: 'https://example.com/'
  });
  const settings = { globalProtection: true, sites: {}, allowlistedSites: [] };

  assert.equal(decideRequest(analysis, settings, null, true).action, 'BLOCKED');
  assert.equal(decideRequest(analysis, settings, null, false).policy, 'BLOCK');
  assert.equal(decideRequest(analysis, settings, null, false).action, 'ALLOWED');
  assert.equal(decideRequest(analysis, { ...settings, globalProtection: false }, null).action, 'ALLOWED');
  assert.equal(decideRequest(analysis, {
    ...settings,
    sites: { 'example.com': { allowedTrackers: ['google-analytics.com'] } }
  }, null).policy, 'ALLOW');

  const knownService = analyzeRequest({
    url: 'https://cdn.jsdelivr.net/collect?client_id=123',
    initiator: 'https://example.com/'
  });
  assert.equal(decideRequest(
    knownService,
    settings,
    classifyHeuristic(knownService)
  ).action, 'ALLOWED');
});

test('legacy tracker allowlist migrates as a global tracker exception', async () => {
  Object.assign(localData, {
    isHeuristicEngineEnabled: false,
    allowlist: ['||google-analytics.com^']
  });
  const settings = await getSettings();
  assert.equal(settings.heuristicDetection, false);
  assert.deepEqual(settings.globalAllowlist, ['google-analytics.com']);
  assert.deepEqual(settings.allowlistedSites, []);
});

test('DNR reconciliation installs curated policy rules and disables blocking globally when paused', async () => {
  dynamicRules = [{
    id: 10000,
    priority: 2,
    action: { type: 'block' },
    condition: { urlFilter: '||old-heuristic.example^' }
  }];

  await synchronizeRules({
    globalProtection: true,
    globalAllowlist: [],
    allowlistedSites: [],
    blocklist: [],
    sites: { 'example.com': { allowedTrackers: ['google-analytics.com'] } }
  });

  assert.ok(dynamicRules.some((rule) =>
    rule.action.type === 'block' && rule.condition.urlFilter === '||google-analytics.com^'
  ));
  assert.ok(dynamicRules.some((rule) =>
    rule.action.type === 'allow' &&
    rule.condition.urlFilter === '||google-analytics.com^' &&
    rule.condition.initiatorDomains?.includes('example.com')
  ));
  assert.ok(!dynamicRules.some((rule) => rule.id === 10000));

  await synchronizeRules({
    globalProtection: false,
    globalAllowlist: [],
    allowlistedSites: [],
    blocklist: [],
    sites: {}
  });
  assert.equal(dynamicRules.some((rule) => rule.id >= 500000 && rule.id < 550000), false);
  assert.deepEqual(rulesetChanges.at(-1), {
    enableRulesetIds: [],
    disableRulesetIds: ['ruleset_1']
  });
});