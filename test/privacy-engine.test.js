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
const {
  createBlockEventReporter,
  createMatchedRuleConfirmer,
  isOurBlockingRule,
  POSSIBLE_BLOCK_ERROR
} = await import('../background/block-reporting.js');

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

test('ERR_BLOCKED_BY_CLIENT is recorded only as a possible block', async () => {
  const possible = [];
  const confirmed = [];
  const reporter = createBlockEventReporter({
    onPossibleBlock: async (details) => possible.push(details.requestId),
    onConfirmedBlock: async (details) => confirmed.push(details.requestId),
    onUpgradePossibleBlock: async () => true
  });

  assert.equal(await reporter.handleError({
    requestId: 'request-1',
    error: POSSIBLE_BLOCK_ERROR
  }), true);
  assert.deepEqual(possible, ['request-1']);
  assert.deepEqual(confirmed, []);
});

test('unrelated client errors are ignored rather than reported as blocks', async () => {
  let possibleCount = 0;
  const reporter = createBlockEventReporter({
    onPossibleBlock: async () => { possibleCount += 1; },
    onConfirmedBlock: async () => {},
    onUpgradePossibleBlock: async () => true
  });

  assert.equal(await reporter.handleError({
    requestId: 'request-2',
    error: 'net::ERR_CONNECTION_RESET'
  }), false);
  assert.equal(possibleCount, 0);
});

test('debug confirmation upgrades the possible record and deduplicates by requestId', async () => {
  const events = [];
  const reporter = createBlockEventReporter({
    onPossibleBlock: async (details) => events.push(`possible:${details.requestId}`),
    onConfirmedBlock: async (details) => events.push(`blocked:${details.requestId}`),
    onUpgradePossibleBlock: async (details) => {
      events.push(`upgrade:${details.requestId}`);
      return true;
    }
  });
  const request = { requestId: 'request-3', url: 'https://tracker.example/pixel' };

  await reporter.handleError({ ...request, error: POSSIBLE_BLOCK_ERROR });
  assert.equal(await reporter.handleDebug({ request, rule: { ruleId: 1 } }, true), true);
  assert.equal(await reporter.handleDebug({ request, rule: { ruleId: 1 } }, true), false);
  assert.equal(await reporter.handleError({ ...request, error: POSSIBLE_BLOCK_ERROR }), false);
  assert.deepEqual(events, ['possible:request-3', 'upgrade:request-3']);
});

test('debug-only block event records once; non-block rules are ignored', async () => {
  const blocked = [];
  const reporter = createBlockEventReporter({
    onPossibleBlock: async () => {},
    onConfirmedBlock: async (details) => blocked.push(details.requestId),
    onUpgradePossibleBlock: async () => true
  });
  const request = { requestId: 'request-4' };

  assert.equal(await reporter.handleDebug({ request }, false), false);
  assert.equal(await reporter.handleDebug({ request }, true), true);
  assert.equal(await reporter.handleDebug({ request }, true), false);
  assert.deepEqual(blocked, ['request-4']);
});

test('matched-rule ownership checks rule IDs because Chrome does not include rule actions', async () => {
  const dynamicRules = [
    { id: 500001, action: { type: 'block' } },
    { id: 500002, action: { type: 'allow' } }
  ];
  const options = {
    staticRulesetIds: ['ruleset_1'],
    dynamicRulesetId: '_dynamic',
    getDynamicRules: async () => dynamicRules
  };

  assert.equal(await isOurBlockingRule({ ruleId: 7, rulesetId: 'ruleset_1' }, options), true);
  assert.equal(await isOurBlockingRule({ ruleId: 500001, rulesetId: '_dynamic' }, options), true);
  assert.equal(await isOurBlockingRule({ ruleId: 500002, rulesetId: '_dynamic' }, options), false);
  assert.equal(await isOurBlockingRule({ ruleId: 5, rulesetId: 'other_ruleset' }, options), false);
});

test('debug event waits for the possible-block record before upgrading it', async () => {
  const events = [];
  let finishPossible;
  const reporter = createBlockEventReporter({
    onPossibleBlock: async () => new Promise((resolve) => {
      finishPossible = () => {
        events.push('possible');
        resolve();
      };
    }),
    onConfirmedBlock: async () => events.push('blocked'),
    onUpgradePossibleBlock: async () => {
      events.push('upgrade');
      return true;
    }
  });
  const request = { requestId: 'request-race' };

  const possibleEvent = reporter.handleError({ ...request, error: POSSIBLE_BLOCK_ERROR });
  await Promise.resolve();
  const debugEvent = reporter.handleDebug({ request }, true);
  finishPossible();
  await Promise.all([possibleEvent, debugEvent]);
  assert.deepEqual(events, ['possible', 'upgrade']);
});

test('matched-rule confirmer limits calls and handles Chrome quota rejection', async () => {
  let currentTime = 100_000;
  let apiCalls = 0;
  const storage = {};
  const confirmer = createMatchedRuleConfirmer({
    getMatchedRules: async () => {
      apiCalls += 1;
      throw new Error('getMatchedRules quota exceeded');
    },
    isOurBlockingRule: () => true,
    sessionStorage: {
      async get(key) { return storage[key] ? { [key]: storage[key] } : {}; },
      async set(values) { Object.assign(storage, values); }
    },
    now: () => currentTime,
    minIntervalMs: 31_000
  });

  const first = await confirmer(9);
  const limited = await confirmer(9);
  assert.equal(first.checked, false);
  assert.match(first.error.message, /quota/);
  assert.equal(limited.checked, false);
  assert.equal(apiCalls, 1);

  currentTime += 31_001;
  await confirmer(9);
  assert.equal(apiCalls, 2);
});

test('matched-rule queries serialize without mixing tab results', async () => {
  const storage = {};
  let currentTime = 200_000;
  const confirmer = createMatchedRuleConfirmer({
    getMatchedRules: async ({ tabId }) => {
      const response = {
        rulesMatchedInfo: Array.from({ length: tabId }, (_, index) => ({
          rule: { ruleId: index + 1, rulesetId: 'ruleset_1' }
        }))
      };
      currentTime += 31_001;
      return response;
    },
    isOurBlockingRule: (rule) => rule?.rulesetId === 'ruleset_1',
    sessionStorage: {
      async get(key) { return storage[key] ? { [key]: storage[key] } : {}; },
      async set(values) { Object.assign(storage, values); }
    },
    now: () => currentTime
  });

  const [firstTab, secondTab] = await Promise.all([
    confirmer(1),
    confirmer(2)
  ]);

  assert.equal(firstTab.matchedRuleCount, 1);
  assert.equal(secondTab.matchedRuleCount, 2);
});

test('DNR truncation preserves high-priority exceptions and reports dropped rules', async () => {
  dynamicRules = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    await synchronizeRules({
      globalProtection: true,
      globalAllowlist: ['always-allow.example'],
      allowlistedSites: ['trusted.example'],
      blocklist: Array.from({ length: 5001 }, (_, index) => `blocked-${index}.example`),
      sites: {}
    });
  } finally {
    console.warn = originalWarn;
  }

  const managedRules = dynamicRules.filter((rule) => rule.id >= 500000 && rule.id < 505000);
  assert.equal(managedRules.length, 5000);
  assert.ok(managedRules.some((rule) =>
    rule.priority === 300 &&
    rule.action.type === 'allow' &&
    rule.condition.initiatorDomains?.includes('trusted.example')
  ));
  assert.ok(managedRules.some((rule) =>
    rule.priority === 200 &&
    rule.action.type === 'allow' &&
    rule.condition.urlFilter === '||always-allow.example^'
  ));
  assert.ok(managedRules.every((rule, index) =>
    index === 0 || managedRules[index - 1].priority >= rule.priority
  ));

  const { ruleCapacityWarning } = localData;
  assert.equal(ruleCapacityWarning.truncated, true);
  assert.ok(ruleCapacityWarning.dropped > 0);
  assert.equal(ruleCapacityWarning.limit, 5000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rule cap reached/i);

  await synchronizeRules({
    globalProtection: true,
    globalAllowlist: [],
    allowlistedSites: [],
    blocklist: [],
    sites: {}
  });
  assert.equal(Object.hasOwn(localData, 'ruleCapacityWarning'), false);
});