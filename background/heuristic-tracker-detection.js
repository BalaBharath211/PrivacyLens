// heuristic-tracker-detection.js

/**
 * Checks if a potential tracker has been seen on enough different sites to be classified as a tracker.
 * If it has, a new dynamic blocking rule is added.
 * This is the core of the "Privacy Badger" model.
 * @param {string} potentialTrackerDomain - The third-party domain that might be a tracker.
 * @param {string} initiatorDomain - The first-party domain where the request originated.
 */
export async function checkForHeuristicMatch(potentialTrackerDomain, initiatorDomain) {
    if (!potentialTrackerDomain || !initiatorDomain || potentialTrackerDomain === initiatorDomain) {
        return;
    }

    try {
        // --- ADDED LOGIC ---
        // First, check if the domain is on the user's allowlist.
        const { allowlist = [] } = await chrome.storage.local.get('allowlist');
        if (allowlist.includes(potentialTrackerDomain)) {
            // If it's on the list, do nothing further.
            console.log(`Heuristic check skipped: ${potentialTrackerDomain} is on the allowlist.`);
            return;
        }
        // --- END OF ADDED LOGIC ---

        // 1. Get current tracking data and dynamically added rules from storage
        const data = await chrome.storage.local.get(['heuristicTrackers', 'dynamicallyAddedRules']);
        const trackers = data.heuristicTrackers || {};
        const dynamicRules = data.dynamicallyAddedRules || {};

        // If this domain is already blocked dynamically, no need to do anything else.
        if (dynamicRules[potentialTrackerDomain]) {
            return;
        }

        // 2. Add the new site to the set for this domain
        if (!trackers[potentialTrackerDomain]) {
            trackers[potentialTrackerDomain] = [];
        }
        if (!trackers[potentialTrackerDomain].includes(initiatorDomain)) {
            trackers[potentialTrackerDomain].push(initiatorDomain);
        }

        // 3. Save back to storage
        await chrome.storage.local.set({ heuristicTrackers: trackers });

        // 4. Check if it now qualifies as a tracker (seen on 3 or more unique sites)
        if (trackers[potentialTrackerDomain].length >= 3) {
            console.log(`Heuristic match: ${potentialTrackerDomain} is now considered a tracker.`);
            await addNewDynamicBlockingRule(potentialTrackerDomain);
        }
    } catch (error) {
        console.error("Error in heuristic tracker check:", error);
    }
}

/**
 * Adds a new dynamic rule to the declarativeNetRequest ruleset to block the specified domain.
 * @param {string} trackerDomain - The domain to block.
 */
async function addNewDynamicBlockingRule(trackerDomain) {
    try {
        const { nextRuleId = 10000 } = await chrome.storage.local.get('nextRuleId'); // Start dynamic rules at a high number

        const newRule = {
            id: nextRuleId,
            priority: 2, // Higher priority than static rules if needed
            action: { type: 'block' },
            condition: {
                urlFilter: `||${trackerDomain}^`,
                resourceTypes: ['main_frame', 'sub_frame', 'script', 'image', 'stylesheet', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other']
            }
        };

        await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [newRule]
        });

        // Store a record that this rule was added to prevent re-adding it
        const { dynamicallyAddedRules = {} } = await chrome.storage.local.get('dynamicallyAddedRules');
        dynamicallyAddedRules[trackerDomain] = newRule.id;

        await chrome.storage.local.set({
            dynamicallyAddedRules: dynamicallyAddedRules,
            nextRuleId: nextRuleId + 1 // Increment for the next rule
        });

        console.log(`Added new dynamic rule #${newRule.id} to block ${trackerDomain}`);

    } catch (error) {
        console.error("Error adding new dynamic blocking rule:", error);
    }
}