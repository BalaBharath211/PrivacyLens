// background.js

import {
  openPrivacyDashboardDB,
  addOrGetExisting,
  getAllItems,
  clearStores,
  OBJECT_STORE_TRACKERS,
  OBJECT_STORE_REQUESTS,
  OBJECT_STORE_DOMAINS,
  OBJECT_STORE_REQUEST_DATA_TYPES
} from '../storage/indexedDB.js';

import { checkForHeuristicMatch } from './heuristic-tracker-detection.js';

// Prevent duplicate logging between request listeners.
const recentlyLoggedUrls = new Set();

function markRecentlyLogged(url) {
  recentlyLoggedUrls.add(url);
  setTimeout(() => recentlyLoggedUrls.delete(url), 1000);
}

/**
 * Returns request context only when the request is third party.
 */
function getThirdPartyRequestContext(initiator, requestUrl) {
  if (
    !initiator ||
    initiator === 'unknown' ||
    (!initiator.startsWith('http://') && !initiator.startsWith('https://'))
  ) {
    return null;
  }

  try {
    const initiatorDomain = new URL(initiator).hostname;
    const requestDomain = new URL(requestUrl).hostname;

    if (initiatorDomain === requestDomain) {
      return null;
    }

    return { initiatorDomain, requestDomain };
  } catch {
    return null;
  }
}

/**
 * Logs a tracker-candidate request to IndexedDB.
 */
async function logRequestToDB(
  requestUrl,
  initiator,
  blocked,
  matchedRuleId = null,
  resourceType = 'other'
) {
  try {
    let trackerHostname = 'unknown-tracker-domain';

    try {
      trackerHostname = new URL(requestUrl).hostname;
    } catch (error) {
      console.warn('Could not parse tracker URL hostname:', requestUrl, error);
    }

    const trackerData = { url: trackerHostname, name: trackerHostname };
    const tracker = await addOrGetExisting(
      OBJECT_STORE_TRACKERS,
      trackerData,
      'url',
      trackerData.url
    );

    let initiatorHostname = 'unknown-initiator-domain';

    try {
      if (initiator && initiator !== 'unknown') {
        initiatorHostname = new URL(initiator).hostname;
      }
    } catch {
      // Non-HTTP initiators are ignored.
    }

    const domainData = { name: initiatorHostname };
    const domain = await addOrGetExisting(
      OBJECT_STORE_DOMAINS,
      domainData,
      'name',
      domainData.name
    );

    const requestEntry = {
      requestUrl,
      timestamp: new Date().toISOString(),
      initiatorDomainId: domain.id,
      trackerId: tracker.id,
      matchedRuleId,
      blocked,
      resourceType
    };

    await addOrGetExisting(OBJECT_STORE_REQUESTS, requestEntry);

    const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
    chrome.action.setBadgeText({ text: allRequests.length.toString() });
    chrome.action.setBadgeBackgroundColor({
      color: blocked ? '#e74c3c' : '#3498db'
    });
  } catch (error) {
    console.error('Error saving tracker data to IndexedDB:', error);
  }
}

/**
 * Heuristic processing:
 * evaluates only third-party hostnames, and only when enabled in Settings.
 */
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const { initiator, url } = details;
    const context = getThirdPartyRequestContext(initiator, url);

    if (!context) return;

    try {
      const { isHeuristicEngineEnabled = true } =
        await chrome.storage.local.get('isHeuristicEngineEnabled');

      if (isHeuristicEngineEnabled) {
        await checkForHeuristicMatch(
          context.requestDomain,
          context.initiatorDomain
        );
      }
    } catch (error) {
      console.error('Error processing heuristic tracker candidate:', error);
    }
  },
  { urls: ['<all_urls>'] }
);

/**
 * Logs completed, third-party requests as unblocked tracker candidates.
 */
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const { initiator, url, type } = details;
    const context = getThirdPartyRequestContext(initiator, url);

    if (!context || recentlyLoggedUrls.has(url)) return;

    markRecentlyLogged(url);
    logRequestToDB(url, initiator, false, null, type);
  },
  { urls: ['<all_urls>'] }
);

/**
 * Logs blocked, third-party requests.
 */
if (
  chrome.declarativeNetRequest &&
  chrome.declarativeNetRequest.onRuleMatchedDebug
) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const { request, rule } = info;
    const context = getThirdPartyRequestContext(
      request.initiator,
      request.url
    );

    if (!context || recentlyLoggedUrls.has(request.url)) return;

    console.log(
      `[Tracker Blocked] Rule ID: ${rule.ruleId}, URL: ${request.url}`
    );

    markRecentlyLogged(request.url);
    logRequestToDB(
      request.url,
      request.initiator,
      true,
      rule.ruleId,
      request.resourceType
    );
  });

  console.log('Declarative Net Request Debug Listener attached successfully.');
} else {
  console.warn('chrome.declarativeNetRequest.onRuleMatchedDebug API not available.');
}

/**
 * Initialize defaults without overwriting existing user choices.
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Privacy Dashboard Extension Installed!');

  const stored = await chrome.storage.local.get([
    'isHeuristicEngineEnabled',
    'allowlist'
  ]);

  const initialValues = {};

  if (typeof stored.isHeuristicEngineEnabled !== 'boolean') {
    initialValues.isHeuristicEngineEnabled = true;
  }

  if (!Array.isArray(stored.allowlist)) {
    initialValues.allowlist = [];
  }

  if (Object.keys(initialValues).length > 0) {
    await chrome.storage.local.set(initialValues);
  }

  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({
        settings: {
          blockTrackers: true,
          logTrackers: true,
          heuristicBlocking: true,
          darkMode: false
        }
      });
    }
  });
});

// Message listener for popup actions.
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === 'getTrackerSummary') {
    try {
      const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
      sendResponse({ trackerCount: allRequests.length });
    } catch (error) {
      console.error('Error retrieving tracker summary for popup:', error);
      sendResponse({ trackerCount: 0, error: error.message });
    }
    return true;
  }

  if (message.action === 'clearAllData') {
    try {
      await chrome.storage.local.remove([
        'heuristicTrackers',
        'dynamicallyAddedRules',
        'nextRuleId',
        'isHeuristicEngineEnabled',
        'allowlist'
      ]);

      const dynamicRules =
        await chrome.declarativeNetRequest.getDynamicRules();

      const ruleIdsToRemove = dynamicRules.map((rule) => rule.id);

      if (ruleIdsToRemove.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: ruleIdsToRemove
        });
      }

      await clearStores([
        OBJECT_STORE_TRACKERS,
        OBJECT_STORE_REQUESTS,
        OBJECT_STORE_DOMAINS,
        OBJECT_STORE_REQUEST_DATA_TYPES
      ]);

      chrome.action.setBadgeText({ text: '' });
      sendResponse({ success: true, message: 'All data cleared.' });
    } catch (error) {
      console.error('Error clearing data:', error);
      sendResponse({
        success: false,
        message: error.message || 'Failed to clear data.',
        error: error.message
      });
    }

    return true;
  }
});