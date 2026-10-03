// background.js

import {
  analyzeRequest
} from './request-analyzer.js';
import { classifyHeuristic } from './heuristic-tracker-detection.js';
import { decideRequest } from './risk-engine.js';
import { synchronizeRules } from './rule-manager.js';
import {
  createBlockEventReporter,
  createMatchedRuleConfirmer,
  isOurBlockingRule
} from './block-reporting.js';
import {
  getSettings,
  clearHeuristicObservations,
  observeThirdParty,
  setSiteProtection,
  setSiteTrackerException,
  updateSettings
} from '../storage/settings.js';
import {
  clearStatistics,
  getSiteData,
  initializeStorage,
  pruneStatistics,
  recordRequest,
  upgradePossibleBlock
} from '../storage/indexedDB.js';
import { initializeTrackerDB } from '../tracker-db/tracker-db.js';
import { createPopupRefreshNotifier } from './popup-refresh.js';
import {
  buildActivitySummary,
  classifyActivityRecord,
  getActivityCategory
} from './activity-model.js';

const LEGACY_STORAGE_KEYS = [
  'heuristicTrackers', 'dynamicallyAddedRules', 'nextRuleId',
  'isHeuristicEngineEnabled', 'allowlist', 'settings'
];
const AGGREGATE_PRUNE_ALARM = 'privacy-lens-prune-aggregates';
let readyPromise;
const popupRefreshNotifier = createPopupRefreshNotifier({
  sendMessage: (message) => chrome.runtime.sendMessage(message)
});

function ensureReady() {
  if (!readyPromise) {
    readyPromise = initializeRuntime().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

async function initializeRuntime() {
  await initializeTrackerDB();
  await initializeStorage();
  await pruneStatistics();
  chrome.alarms.create(AGGREGATE_PRUNE_ALARM, { periodInMinutes: 60 });
  const settings = await getSettings();
  await updateSettings(settings);
  await synchronizeRules(settings);
  if (typeof chrome.declarativeNetRequest.setExtensionActionOptions === 'function') {
    try {
      await chrome.declarativeNetRequest.setExtensionActionOptions({
        displayActionCountAsBadgeText: true
      });
    } catch (error) {
      console.warn('Could not enable the DNR action-count badge:', error);
    }
  }
  await chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
}

async function processRequest(details, outcomeOverride = null) {
  await ensureReady();
  const analysis = analyzeRequest(details);
  if (!analysis.isThirdParty || !analysis.domain || !analysis.siteDomain) return;

  const settings = await getSettings();
  let heuristic = { classification: 'NONE', confidence: 0, signals: [] };
  if (settings.heuristicDetection && !analysis.isTracker) {
    const observedSiteCount = await observeThirdParty(
      analysis.domain,
      analysis.siteDomain
    );
    heuristic = classifyHeuristic(
      analysis,
      observedSiteCount,
      settings.protectionLevel
    );
  }

  const decision = outcomeOverride || decideRequest(analysis, settings, heuristic);
  await recordRequest(analysis, {
    ...decision,
    confidence: heuristic.confidence,
    signals: heuristic.signals
  });

  popupRefreshNotifier.notify();
}

const blockEventReporter = createBlockEventReporter({
  onPossibleBlock: (details) => processRequest(details, {
    action: 'possibleBlock',
    policy: 'POSSIBLE_BLOCK',
    reason: 'ERR_BLOCKED_BY_CLIENT is a best-effort signal; another client may have blocked the request.'
  }),
  onConfirmedBlock: (details) => processRequest(details, {
    action: 'BLOCKED',
    policy: 'BLOCK',
    reason: 'A PrivacyLens DNR block rule matched this request.'
  }),
  onUpgradePossibleBlock: (details) => upgradePossibleBlock(details.requestId)
});

const confirmMatchedRulesForTab = createMatchedRuleConfirmer({
  getMatchedRules: chrome.declarativeNetRequest.getMatchedRules?.bind(
    chrome.declarativeNetRequest
  ),
  isOurBlockingRule: (rule) => isOurBlockingRule(rule, {
    staticRulesetIds: ['ruleset_1'],
    dynamicRulesetId: chrome.declarativeNetRequest.DYNAMIC_RULESET_ID || '_dynamic',
    getDynamicRules: () => chrome.declarativeNetRequest.getDynamicRules()
  }),
  sessionStorage: chrome.storage.session
});

chrome.webRequest.onCompleted.addListener((details) => {
  processRequest(details).catch((error) => {
    console.error('Could not process completed request:', error);
  });
}, { urls: ['<all_urls>'] });

if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    isOurBlockingRule(info?.rule)
      .then((isBlockRule) => blockEventReporter.handleDebug(info, isBlockRule))
      .catch((error) => console.error('Could not record a DNR rule match:', error));
  });
}

chrome.webRequest.onErrorOccurred.addListener((details) => {
  blockEventReporter.handleError(details).catch((error) => {
    console.error('Could not record a possible blocked request:', error);
  });
}, { urls: ['<all_urls>'] });

async function activeTabContext(message) {
  const parsed = analyzeRequest({
    url: message.url,
    initiator: message.url,
    tabId: message.tabId
  });
  if (!parsed.siteDomain) return null;
  return { siteDomain: parsed.siteDomain, tabId: parsed.tabId };
}

function summarizeRequests(requests) {
  const groups = new Map();
  for (const request of requests) {
    const key = request.trackerId || request.domain;
    let group = groups.get(key);
    if (!group) {
      const classification = classifyActivityRecord(request);
      group = {
        id: key,
        domain: request.domain,
        trackerName: request.trackerName || request.domain,
        company: request.company || null,
        category: getActivityCategory(request),
        classification,
        purpose: request.purpose || null,
        confidence: request.confidence || 0,
        requestCount: 0,
        blockedCount: 0,
        allowedCount: 0,
        flaggedCount: 0,
        action: request.action
      };
      groups.set(key, group);
    }
    group.requestCount += 1;
    if (request.action === 'BLOCKED') group.blockedCount += 1;
    if (request.action === 'ALLOWED') group.allowedCount += 1;
    if (request.action === 'FLAGGED') group.flaggedCount += 1;
  }
  return [...groups.values()].sort((left, right) => right.requestCount - left.requestCount);
}

async function getPopupData(message) {
  await ensureReady();
  const context = await activeTabContext(message);
  const settings = await getSettings();
  if (!context) return { siteDomain: null, settings, requests: [], trackers: [], summary: {} };

  const matchedRules = await confirmMatchedRulesForTab(context.tabId);
  const { site, requests } = await getSiteData(context.siteDomain);
  const siteSettings = settings.sites[context.siteDomain] || {};
  const siteTrusted = settings.allowlistedSites.includes(context.siteDomain);

  return {
    siteDomain: context.siteDomain,
    tabId: context.tabId,
    protectionEnabled: settings.globalProtection &&
      siteSettings.protectionEnabled !== false && !siteTrusted,
    siteTrusted,
    settings,
    requests,
    trackers: summarizeRequests(requests),
    summary: {
      ...buildActivitySummary(site, requests),
      possibleBlock: site?.possibleBlockCount || 0,
      blockedThisPage: matchedRules.matchedRuleCount || 0
    }
  };
}

async function handleMessage(message) {
  await ensureReady();

  if (message.action === 'getPopupData') return getPopupData(message);
  if (message.action === 'getSettings') {
    const settings = await getSettings();
    const { ruleCapacityWarning = null } =
      await chrome.storage.local.get('ruleCapacityWarning');
    return { ...settings, ruleCapacityWarning };
  }

  if (message.action === 'setGlobalProtection') {
    const settings = await updateSettings({ globalProtection: Boolean(message.enabled) });
    await synchronizeRules(settings);
    return { success: true };
  }

  if (message.action === 'setSiteProtection') {
    const settings = await setSiteProtection(message.siteDomain, message.enabled);
    await synchronizeRules(settings);
    return { success: true };
  }

  if (message.action === 'trustSite') {
    const settings = await getSettings();
    const sites = new Set(settings.allowlistedSites);
    if (message.trusted) sites.add(message.siteDomain);
    else sites.delete(message.siteDomain);
    const nextSettings = await updateSettings({ allowlistedSites: [...sites] });
    await synchronizeRules(nextSettings);
    return { success: true };
  }

  if (message.action === 'setTrackerAllowed') {
    const settings = await setSiteTrackerException(
      message.siteDomain,
      message.trackerId || message.domain,
      message.allowed
    );
    await synchronizeRules(settings);
    return { success: true };
  }

  if (message.action === 'setTrackerBlockedGlobally') {
    const settings = await getSettings();
    const blocklist = new Set(settings.blocklist);
    if (message.blocked) blocklist.add(message.domain);
    else blocklist.delete(message.domain);
    const nextSettings = await updateSettings({ blocklist: [...blocklist] });
    await synchronizeRules(nextSettings);
    return { success: true };
  }

  if (message.action === 'updateSettings') {
    const settings = await updateSettings(message.settings || {});
    await synchronizeRules(settings);
    const { ruleCapacityWarning = null } =
      await chrome.storage.local.get('ruleCapacityWarning');
    return { success: true, settings, ruleCapacityWarning };
  }

  if (message.action === 'clearData') {
    await clearStatistics();
    await clearHeuristicObservations();
    return { success: true };
  }

  if (message.action === 'resetSettings') {
    const settings = await updateSettings({
      globalProtection: true,
      protectionLevel: 'balanced',
      heuristicDetection: true,
      allowlistedSites: [],
      globalAllowlist: [],
      blocklist: [],
      sites: {}
    });
    await synchronizeRules(settings);
    return { success: true, settings };
  }

  return { success: false, message: 'Unknown extension action.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'requestRecorded') return;
  handleMessage(message || {})
    .then(sendResponse)
    .catch((error) => {
      console.error('Extension action failed:', error);
      sendResponse({ success: false, message: error.message || 'Request failed.' });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureReady().catch((error) => console.error('Initialization failed:', error));
});

chrome.runtime.onStartup.addListener(() => {
  ensureReady().catch((error) => console.error('Startup initialization failed:', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    confirmMatchedRulesForTab.resetTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  confirmMatchedRulesForTab.resetTab(tabId);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AGGREGATE_PRUNE_ALARM) return;
  pruneStatistics().catch((error) => {
    console.error('Could not prune old aggregate statistics:', error);
  });
});

ensureReady().catch((error) => console.error('Background initialization failed:', error));