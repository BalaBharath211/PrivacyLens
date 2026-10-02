import { getTrackerCatalog } from '../tracker-db/tracker-db.js';

const MANAGED_RULE_START = 500000;
const MANAGED_RULE_END = 505000;
const MAX_DYNAMIC_RULES = 5000;
const LEGACY_RULE_START = 10000;
const ALLOWED_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'
];

let updateQueue = Promise.resolve();

function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

function urlCondition(domain) {
  return {
    urlFilter: `||${domain}^`,
    resourceTypes: ALLOWED_RESOURCE_TYPES
  };
}

function buildPolicyRules(settings) {
  const catalog = getTrackerCatalog();
  const rules = [];
  const isProtected = settings.globalProtection !== false;
  const globallyAllowed = new Set(settings.globalAllowlist || []);

  if (isProtected) {
    for (const tracker of catalog) {
      if (tracker.type === 'service') {
        rules.push({
          priority: 100,
          action: { type: 'allow' },
          condition: urlCondition(tracker.domain)
        });
      } else if (
        tracker.type === 'tracker' &&
        !globallyAllowed.has(tracker.id) &&
        !globallyAllowed.has(tracker.domain)
      ) {
        rules.push({
          priority: 10,
          action: { type: 'block' },
          condition: urlCondition(tracker.domain)
        });
      }
    }

    for (const rawDomain of settings.blocklist || []) {
      const domain = normalizeDomain(rawDomain);
      if (!domain) continue;
      rules.push({
        priority: 150,
        action: { type: 'block' },
        condition: urlCondition(domain)
      });
    }

    for (const rawDomain of settings.globalAllowlist || []) {
      const tracker = catalog.find((entry) => entry.id === rawDomain);
      const domain = normalizeDomain(tracker?.domain || rawDomain);
      if (!domain) continue;
      rules.push({
        priority: 200,
        action: { type: 'allow' },
        condition: urlCondition(domain)
      });
    }

    const siteExceptions = new Map();
    for (const siteDomain of settings.allowlistedSites || []) {
      const domain = normalizeDomain(siteDomain);
      if (domain) siteExceptions.set(domain, null);
    }

    for (const [siteDomain, site] of Object.entries(settings.sites || {})) {
      const normalizedSite = normalizeDomain(siteDomain);
      if (!normalizedSite) continue;
      if (site.protectionEnabled === false) siteExceptions.set(normalizedSite, null);
      for (const trackerId of site.allowedTrackers || []) {
        if (!siteExceptions.has(normalizedSite)) siteExceptions.set(normalizedSite, new Set());
        const value = siteExceptions.get(normalizedSite);
        if (value) value.add(trackerId);
      }
    }

    for (const [siteDomain, trackerIds] of siteExceptions) {
      if (trackerIds === null) {
        rules.push({
          priority: 300,
          action: { type: 'allow' },
          condition: { initiatorDomains: [siteDomain], resourceTypes: ALLOWED_RESOURCE_TYPES }
        });
        continue;
      }

      for (const trackerId of trackerIds) {
        const tracker = catalog.find((entry) => entry.id === trackerId);
        const domain = normalizeDomain(tracker?.domain || trackerId);
        if (!domain) continue;
        rules.push({
          priority: 250,
          action: { type: 'allow' },
          condition: { ...urlCondition(domain), initiatorDomains: [siteDomain] }
        });
      }
    }
  }

  const uniqueRules = new Map();
  for (const rule of rules) {
    const key = JSON.stringify([
      rule.action.type,
      rule.condition.urlFilter || '',
      rule.condition.initiatorDomains || [],
      rule.condition.resourceTypes || []
    ]);
    const existing = uniqueRules.get(key);
    if (!existing || rule.priority > existing.priority) uniqueRules.set(key, rule);
  }
  return [...uniqueRules.values()].slice(0, MAX_DYNAMIC_RULES);
}

async function reconcileRules(settings) {
  const isProtected = settings.globalProtection !== false;
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: isProtected ? ['ruleset_1'] : [],
    disableRulesetIds: isProtected ? [] : ['ruleset_1']
  });

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const managedRules = existingRules.filter((rule) =>
    rule.id >= MANAGED_RULE_START && rule.id < MANAGED_RULE_END
  );
  const legacyHeuristicRules = existingRules.filter((rule) =>
    rule.id >= LEGACY_RULE_START &&
    rule.id < MANAGED_RULE_START &&
    rule.priority === 2 &&
    rule.action?.type === 'block' &&
    typeof rule.condition?.urlFilter === 'string' &&
    !rule.condition.initiatorDomains
  );
  const removeRuleIds = [...managedRules, ...legacyHeuristicRules].map((rule) => rule.id);
  const addRules = buildPolicyRules(settings).map((rule, index) => ({
    ...rule,
    id: MANAGED_RULE_START + index
  }));

  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
  }
}

export function synchronizeRules(settings) {
  const next = updateQueue.then(() => reconcileRules(settings));
  updateQueue = next.catch((error) => {
    console.error('Could not synchronize DNR policy rules:', error);
  });
  return next;
}