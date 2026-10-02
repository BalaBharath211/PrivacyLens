// background.js

import {
  analyzeRequest
} from './request-analyzer.js';
import { classifyHeuristic } from './heuristic-tracker-detection.js';
import { decideRequest } from './risk-engine.js';
import { synchronizeRules } from './rule-manager.js';
import {
  getSettings,
  observeThirdParty,
  setSiteProtection,
  setSiteTrackerException,
  updateSettings
} from '../storage/settings.js';
import {
  clearStatistics,
  getSiteData,
  initializeStorage,
  recordRequest
} from '../storage/indexedDB.js';
import { initializeTrackerDB } from '../tracker-db/tracker-db.js';

const LEGACY_STORAGE_KEYS = [
  'heuristicTrackers', 'dynamicallyAddedRules', 'nextRuleId',
  'isHeuristicEngineEnabled', 'allowlist', 'settings'
];
let readyPromise;
let badgeQueue = Promise.resolve();
const processedBlockRequests = new Map();

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
  const settings = await getSettings();
  await updateSettings(settings);
  await synchronizeRules(settings);
  await chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
}

function sendPopupRefresh() {
  chrome.runtime.sendMessage({ action: 'requestRecorded' }).catch(() => {});
}

async function updateTabBadge(tabId, count) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const text = count > 99 ? '99+' : count > 0 ? String(count) : '';
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: '#b74432'
  });
}

async function incrementBlockedBadge(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || !chrome.storage.session) return;
  const operation = badgeQueue.then(async () => {
    const { blockedByTab = {} } = await chrome.storage.session.get('blockedByTab');
    const nextCount = (blockedByTab[tabId] || 0) + 1;
    blockedByTab[tabId] = nextCount;
    await chrome.storage.session.set({ blockedByTab });
    await updateTabBadge(tabId, nextCount);
  });
  badgeQueue = operation.catch((error) => {
    console.error('Could not increment blocked request badge:', error);
  });
  return operation;
}

async function resetTabBadge(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const operation = badgeQueue.then(async () => {
    if (chrome.storage.session) {
      const { blockedByTab = {} } = await chrome.storage.session.get('blockedByTab');
      delete blockedByTab[tabId];
      await chrome.storage.session.set({ blockedByTab });
    }
    await updateTabBadge(tabId, 0);
  });
  badgeQueue = operation.catch((error) => {
    console.error('Could not reset blocked request badge:', error);
  });
  return operation;
}

async function processRequest(details, blockedByDnr = false) {
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

  const decision = decideRequest(analysis, settings, heuristic, blockedByDnr);
  await recordRequest(analysis, {
    ...decision,
    confidence: heuristic.confidence,
    signals: heuristic.signals
  });

  if (blockedByDnr) await incrementBlockedBadge(analysis.tabId);
  sendPopupRefresh();
}

chrome.webRequest.onCompleted.addListener((details) => {
  processRequest(details).catch((error) => {
    console.error('Could not process completed request:', error);
  });
}, { urls: ['<all_urls>'] });

if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (info?.rule?.action?.type !== 'block') return;
    const request = info?.request;
    if (!request) return;
    if (request.requestId != null) {
      const key = `${request.tabId}:${request.requestId}`;
      const now = Date.now();
      if (processedBlockRequests.has(key)) return;
      processedBlockRequests.set(key, now);
      for (const [processedKey, timestamp] of processedBlockRequests) {
        if (now - timestamp > 5000) processedBlockRequests.delete(processedKey);
      }
      while (processedBlockRequests.size > 1000) {
        processedBlockRequests.delete(processedBlockRequests.keys().next().value);
      }
    }
    processRequest({
      url: request.url,
      initiator: request.initiator,
      type: request.type || request.resourceType,
      tabId: request.tabId,
      requestId: request.requestId
    }, true).catch((error) => {
      console.error('Could not record a DNR-blocked request:', error);
    });
  });
}

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
      group = {
        id: key,
        domain: request.domain,
        trackerName: request.trackerName || request.domain,
        company: request.company || null,
        category: request.category || 'Unknown',
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

  const { site, requests } = await getSiteData(context.siteDomain);
  const session = chrome.storage.session
    ? await chrome.storage.session.get('blockedByTab')
    : {};
  const blockedByTab = session.blockedByTab || {};
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
      blocked: site?.blockedCount || 0,
      allowed: site?.allowedCount || 0,
      flagged: site?.flaggedCount || 0,
      blockedThisPage: blockedByTab[context.tabId] || 0
    }
  };
}

async function handleMessage(message) {
  await ensureReady();

  if (message.action === 'getPopupData') return getPopupData(message);
  if (message.action === 'getSettings') return getSettings();

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
    return { success: true, settings };
  }

  if (message.action === 'clearData') {
    await clearStatistics();
    if (chrome.storage.session) await chrome.storage.session.remove('blockedByTab');
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
    resetTabBadge(tabId).catch((error) => console.error('Could not reset tab badge:', error));
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!chrome.storage.session) return;
  try {
    const { blockedByTab = {} } = await chrome.storage.session.get('blockedByTab');
    await updateTabBadge(tabId, blockedByTab[tabId] || 0);
  } catch (error) {
    console.error('Could not restore active-tab badge:', error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!chrome.storage.session) return;
  chrome.storage.session.get('blockedByTab').then(({ blockedByTab = {} }) => {
    delete blockedByTab[tabId];
    return chrome.storage.session.set({ blockedByTab });
  }).catch((error) => console.error('Could not remove closed-tab badge state:', error));
});

ensureReady().catch((error) => console.error('Background initialization failed:', error));