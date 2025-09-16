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

// --- NEW: A temporary cache to prevent logging the same URL twice ---
// (once from onRuleMatchedDebug, and again from onCompleted)
const recentlyLoggedUrls = new Set();

/**
 * A centralized function to log request data to IndexedDB.
 * @param {string} requestUrl - The URL of the request.
 * @param {string} initiator - The initiator of the request.
 * @param {boolean} blocked - Whether the request was blocked.
 * @param {number} matchedRuleId - The ID of the rule that was matched, if any.
 * @param {string} resourceType - The type of the resource requested.
 */
async function logRequestToDB(requestUrl, initiator, blocked, matchedRuleId = null, resourceType = 'other') {
    try {
        let trackerHostname = 'unknown-tracker-domain';
        try {
            trackerHostname = new URL(requestUrl).hostname;
        } catch (e) {
            console.warn("Could not parse tracker URL hostname:", requestUrl, e);
        }

        const trackerData = { url: trackerHostname, name: trackerHostname };
        const tracker = await addOrGetExisting(OBJECT_STORE_TRACKERS, trackerData, 'url', trackerData.url);

        let initiatorHostname = 'unknown-initiator-domain';
        try {
            if (initiator && initiator !== "unknown") {
                initiatorHostname = new URL(initiator).hostname;
            }
        } catch (e) {
            // This can happen with non-http initiators, safe to ignore.
        }

        const domainData = { name: initiatorHostname };
        const domain = await addOrGetExisting(OBJECT_STORE_DOMAINS, domainData, 'name', domainData.name);

        const requestEntry = {
            requestUrl: requestUrl,
            timestamp: new Date().toISOString(),
            initiatorDomainId: domain.id,
            trackerId: tracker.id,
            matchedRuleId: matchedRuleId,
            blocked: blocked,
            resourceType: resourceType,
        };
        await addOrGetExisting(OBJECT_STORE_REQUESTS, requestEntry);

        // Update badge count based on all logged requests now, not just blocked ones.
        const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
        const totalTrackersDetected = allRequests.length;

        chrome.action.setBadgeText({ text: totalTrackersDetected.toString() });
        chrome.action.setBadgeBackgroundColor({ color: blocked ? "#e74c3c" : "#3498db" });

    } catch (dbOpError) {
        console.error("Error saving tracker data to IndexedDB:", dbOpError);
    }
}


// This listener is for the HEURISTIC (Privacy Badger-style) detection.
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => { // --- MODIFIED: Make listener async
    // --- ADD THIS BLOCK ---
    // First, check if the heuristic engine is enabled at all.
    const { isHeuristicEngineEnabled = true } = await chrome.storage.local.get('isHeuristicEngineEnabled');
    if (!isHeuristicEngineEnabled) {
      return; // If disabled, do nothing.
    }
    // --- END ADD ---

    const { initiator, url } = details;
    if (initiator && (initiator.startsWith('http:') || initiator.startsWith('https:'))) {
        try {
            const initiatorUrl = new URL(initiator);
            const requestUrl = new URL(url);
            const initiatorDomain = initiatorUrl.hostname;
            const potentialTrackerDomain = requestUrl.hostname;

            // This function now also needs to check the allowlist
            checkForHeuristicMatch(potentialTrackerDomain, initiatorDomain);
        } catch (e) { /* Ignore invalid URLs */ }
    }
  },
  { urls: ["<all_urls>"] }
);

// --- NEW: Listener for ALL completed third-party requests ---
// This logs requests that were NOT blocked by a rule.
chrome.webRequest.onCompleted.addListener(
    (details) => {
        const { initiator, url, type } = details;
        if (initiator && (initiator.startsWith('http:') || initiator.startsWith('https:'))) {
            try {
                const initiatorDomain = new URL(initiator).hostname;
                const requestDomain = new URL(url).hostname;

                // If it's a third-party request and hasn't just been logged as blocked
                if (initiatorDomain !== requestDomain && !recentlyLoggedUrls.has(url)) {
                    logRequestToDB(url, initiator, false, null, type);
                }
                // Clean up the cache after a short delay
                setTimeout(() => recentlyLoggedUrls.delete(url), 1000);
            } catch(e) { /* Ignore invalid URLs */ }
        }
    },
    { urls: ["<all_urls>"] }
);


// This listener is for STATIC BLOCKING and LOGGING.
// It only fires for BLOCKED requests.
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Privacy Dashboard Extension Installed!");

  // --- REVISED LOGIC FOR CLARITY ---
  // Set default for heuristic engine toggle
  await chrome.storage.local.set({ isHeuristicEngineEnabled: true });
  // Initialize an empty allowlist
  await chrome.storage.local.set({ allowlist: [] });
  
  // Your existing default settings logic
  chrome.storage.local.get("settings", (data) => {
    if (!data.settings) {
      const defaultSettings = {
        blockTrackers: true,
        logTrackers: true,
        heuristicBlocking: true, // This seems redundant now but keeping for your structure
        darkMode: false,
      };
      chrome.storage.local.set({ settings: defaultSettings });
    }
  });
//...

  if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
      const { request, rule } = info;
      console.log(`[Tracker Blocked] Rule ID: ${rule.ruleId}, URL: ${request.url}`);
      
      // Log it to the DB as a blocked request
      logRequestToDB(request.url, request.initiator, true, rule.ruleId, request.resourceType);
      
      // Add to cache to prevent the onCompleted listener from logging it again
      recentlyLoggedUrls.add(request.url);
    });
    console.log("Declarative Net Request Debug Listener attached successfully.");
  } else {
    console.warn("chrome.declarativeNetRequest.onRuleMatchedDebug API not available.");
  }
});

// Message listener for popup actions
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "getTrackerSummary") {
    try {
      const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
      sendResponse({ trackerCount: allRequests.length });
    } catch (error) {
      console.error("Error retrieving tracker summary for popup:", error);
      sendResponse({ trackerCount: 0, error: error.message });
    }
    return true;
  } else if (message.action === "clearAllData") {
    try {
        await chrome.storage.local.remove(['heuristicTrackers', 'dynamicallyAddedRules', 'nextRuleId', 'isHeuristicEngineEnabled', 'allowlist']);
        const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
        const ruleIdsToRemove = dynamicRules.map(rule => rule.id);
        if (ruleIdsToRemove.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIdsToRemove });
        }
      await clearStores([
        OBJECT_STORE_TRACKERS, OBJECT_STORE_REQUESTS, OBJECT_STORE_DOMAINS, OBJECT_STORE_REQUEST_DATA_TYPES
      ]);
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ success: true, message: "All data cleared." });
      console.log("All IndexedDB and heuristic data cleared by user request.");
    } catch (error) {
      console.error("Error clearing data:", error);
      sendResponse({ success: false, message: error.message || "Failed to clear data.", error: error.message });
    }
    return true;
  }
});

