export const POSSIBLE_BLOCK_ERROR = 'net::ERR_BLOCKED_BY_CLIENT';

const MATCHED_RULES_STATE_KEY = 'privacyLensMatchedRuleState';
const MATCHED_RULES_MIN_INTERVAL_MS = 31_000;
const MATCHED_RULES_LOOKBACK_MS = 5 * 60 * 1000;

export async function isOurBlockingRule(rule, {
  staticRulesetIds = [],
  dynamicRulesetId = '_dynamic',
  getDynamicRules
} = {}) {
  if (!rule) return false;
  if (staticRulesetIds.includes(rule.rulesetId)) return true;
  if (rule.rulesetId !== dynamicRulesetId || typeof getDynamicRules !== 'function') {
    return false;
  }

  const dynamicRules = await getDynamicRules();
  return dynamicRules.some((candidate) =>
    candidate.id === rule.ruleId && candidate.action?.type === 'block'
  );
}

export function createBlockEventReporter({
  onPossibleBlock,
  onConfirmedBlock,
  onUpgradePossibleBlock,
  now = Date.now,
  retentionMs = 5_000,
  maxEntries = 1_000
}) {
  const seen = new Map();

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [requestId, entry] of seen) {
      if (entry.timestamp < cutoff) seen.delete(requestId);
    }
    while (seen.size > maxEntries) {
      seen.delete(seen.keys().next().value);
    }
  }

  function remember(requestId, action) {
    if (requestId == null) return;
    seen.set(requestId, { action, timestamp: now() });
    prune();
  }

  async function handleError(details = {}) {
    if (details.error !== POSSIBLE_BLOCK_ERROR) return false;
    prune();
    const previous = details.requestId == null ? null : seen.get(details.requestId);
    if (previous) return false;

    const entry = { action: 'possibleBlock', timestamp: now(), pending: null };
    if (details.requestId != null) seen.set(details.requestId, entry);
    prune();
    entry.pending = Promise.resolve().then(() => onPossibleBlock(details));
    try {
      await entry.pending;
      entry.pending = null;
      return true;
    } catch (error) {
      if (details.requestId != null) seen.delete(details.requestId);
      throw error;
    }
  }

  async function handleDebug(info = {}, isOurBlockRule = false) {
    if (!isOurBlockRule || !info.request) return false;
    prune();
    const request = info.request;
    const previous = request.requestId == null ? null : seen.get(request.requestId);
    if (previous?.action === 'BLOCKED') return false;

    if (previous?.action === 'possibleBlock') {
      try {
        await previous.pending;
      } catch {
        // The confirmed event below remains useful if possible-block persistence failed.
      }
      remember(request.requestId, 'BLOCKED');
      try {
        const upgraded = await onUpgradePossibleBlock(request, info.rule);
        if (!upgraded) await onConfirmedBlock(request, info.rule);
      } catch (error) {
        remember(request.requestId, 'possibleBlock');
        throw error;
      }
      return true;
    }

    remember(request.requestId, 'BLOCKED');
    try {
      await onConfirmedBlock(request, info.rule);
      return true;
    } catch (error) {
      if (request.requestId != null) seen.delete(request.requestId);
      throw error;
    }
  }

  return { handleError, handleDebug, prune };
}

export function createMatchedRuleConfirmer({
  getMatchedRules,
  isOurBlockingRule,
  sessionStorage,
  now = Date.now,
  minIntervalMs = MATCHED_RULES_MIN_INTERVAL_MS
}) {
  const inFlightByTab = new Map();
  let queryQueue = Promise.resolve();

  const confirmTab = async function (tabId) {
    if (!Number.isInteger(tabId) || tabId < 0 || typeof getMatchedRules !== 'function') {
      return { matchedRuleCount: 0, upgradedCount: 0, checked: false };
    }
    if (inFlightByTab.has(tabId)) return inFlightByTab.get(tabId);

    const operation = queryQueue.then(async () => {
      const timestamp = now();
      let state = {
        lastAttemptAt: 0,
        lastMatchedCheckAtByTab: {},
        confirmedByTab: {}
      };
      try {
        const stored = await sessionStorage?.get(MATCHED_RULES_STATE_KEY);
        state = { ...state, ...(stored?.[MATCHED_RULES_STATE_KEY] || {}) };
      } catch {
        // The query itself still has Chrome's own quota protection.
      }

      if (timestamp - state.lastAttemptAt < minIntervalMs) {
        return {
          matchedRuleCount: state.confirmedByTab[tabId] || 0,
          checked: false
        };
      }

      state.lastAttemptAt = timestamp;
      try {
        await sessionStorage?.set({ [MATCHED_RULES_STATE_KEY]: state });
      } catch {
        // Continue; Chrome may still reject the API call if its quota is exhausted.
      }

      try {
        const response = await getMatchedRules({
          tabId,
          minTimeStamp: state.lastMatchedCheckAtByTab[tabId] ||
            timestamp - MATCHED_RULES_LOOKBACK_MS
        });
        const matches = Array.isArray(response?.rulesMatchedInfo)
          ? response.rulesMatchedInfo
          : [];
        let matchedRuleCount = 0;
        for (const match of matches) {
          if (isOurBlockingRule(match?.rule)) matchedRuleCount += 1;
        }

        state.lastMatchedCheckAtByTab[tabId] = timestamp;
        state.confirmedByTab[tabId] = (state.confirmedByTab[tabId] || 0) + matchedRuleCount;
        await sessionStorage?.set({ [MATCHED_RULES_STATE_KEY]: state });
        return {
          matchedRuleCount: state.confirmedByTab[tabId],
          newMatchedRuleCount: matchedRuleCount,
          checked: true
        };
      } catch (error) {
        return {
          matchedRuleCount: state.confirmedByTab[tabId] || 0,
          newMatchedRuleCount: 0,
          checked: false,
          error
        };
      }
    });
    queryQueue = operation.catch(() => {});
    inFlightByTab.set(tabId, operation);

    try {
      return await operation;
    } finally {
      inFlightByTab.delete(tabId);
    }
  };

  confirmTab.resetTab = async function (tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    try {
      const stored = await sessionStorage?.get(MATCHED_RULES_STATE_KEY);
      const state = stored?.[MATCHED_RULES_STATE_KEY];
      if (!state?.confirmedByTab) return;
      delete state.confirmedByTab[tabId];
      state.lastMatchedCheckAtByTab ||= {};
      state.lastMatchedCheckAtByTab[tabId] = now();
      await sessionStorage?.set({ [MATCHED_RULES_STATE_KEY]: state });
    } catch {
      // The next popup query can still refresh the tab count.
    }
  };

  return confirmTab;
}