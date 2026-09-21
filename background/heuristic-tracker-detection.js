// heuristic-tracker-detection.js
let dynamicRuleQueue = Promise.resolve();
function normalizeHostname(value) {
  if (typeof value !== 'string') return null;

  const candidate = value
    .trim()
    .toLowerCase()
    .replace(/^\|\|/, '')
    .replace(/^\|/, '')
    .replace(/\^.*$/, '')
    .replace(/^\*\./, '');

  try {
    return new URL(
      candidate.includes('://') ? candidate : `https://${candidate}`
    ).hostname;
  } catch {
    return null;
  }
}

/**
 * Checks if a potential tracker has been seen on enough different sites to be classified as a tracker.
 * If it has, a new dynamic blocking rule is added.
 * This is the core of the "Privacy Badger" model.
 * @param {string} potentialTrackerDomain - The third-party domain that might be a tracker.
 * @param {string} initiatorDomain - The first-party domain where the request originated.
 */
export async function checkForHeuristicMatch(potentialTrackerDomain, initiatorDomain) {
    potentialTrackerDomain = normalizeHostname(potentialTrackerDomain);
    initiatorDomain = normalizeHostname(initiatorDomain);
    if (!potentialTrackerDomain || !initiatorDomain || potentialTrackerDomain === initiatorDomain) {
        return;
    }

    try {
        // --- ADDED LOGIC ---
        // First, check if the domain is on the user's allowlist.
        const { allowlist = [] } = await chrome.storage.local.get('allowlist');

        const normalizedAllowlist = [
        ...new Set(allowlist.map(normalizeHostname).filter(Boolean))
        ];

        if (JSON.stringify(normalizedAllowlist) !== JSON.stringify(allowlist)) {
        await chrome.storage.local.set({ allowlist: normalizedAllowlist });
        }

        if (normalizedAllowlist.includes(potentialTrackerDomain)) {
        console.log(
            `Heuristic check skipped: ${potentialTrackerDomain} is on the allowlist.`
        );
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

function addNewDynamicBlockingRule(trackerDomain) {
  const queuedUpdate = dynamicRuleQueue.then(() =>
    addNewDynamicBlockingRuleInternal(trackerDomain)
  );

  dynamicRuleQueue = queuedUpdate.catch(error => {
    console.error('Error adding new dynamic blocking rule:', error);
  });

  return queuedUpdate;
}

async function addNewDynamicBlockingRuleInternal(trackerDomain) {
  trackerDomain = normalizeHostname(trackerDomain);
  if (!trackerDomain) return;

  const [
    { nextRuleId = 10000 },
    existingRules,
    { dynamicallyAddedRules = {} }
  ] = await Promise.all([
    chrome.storage.local.get('nextRuleId'),
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.storage.local.get('dynamicallyAddedRules')
  ]);

  // A queued request may have created the rule already.
  if (dynamicallyAddedRules[trackerDomain]) {
    return;
  }

  const usedIds = new Set(existingRules.map(rule => rule.id));
  let ruleId = Math.max(10000, nextRuleId);

  while (usedIds.has(ruleId)) {
    ruleId += 1;
  }

  const newRule = {
    id: ruleId,
    priority: 2,
    action: { type: 'block' },
    condition: {
      urlFilter: `||${trackerDomain}^`,
      resourceTypes: [
        'main_frame',
        'sub_frame',
        'script',
        'image',
        'stylesheet',
        'object',
        'xmlhttprequest',
        'ping',
        'media',
        'websocket',
        'other'
      ]
    }
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [newRule]
  });

  dynamicallyAddedRules[trackerDomain] = ruleId;

  await chrome.storage.local.set({
    dynamicallyAddedRules,
    nextRuleId: ruleId + 1
  });

  console.log(`Added dynamic rule #${ruleId} to block ${trackerDomain}`);
}