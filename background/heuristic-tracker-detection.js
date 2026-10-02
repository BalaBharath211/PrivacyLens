const TRACKING_PATH = /(?:^|\/)(?:collect|analytics|track|tracking|pixel|beacon|events?)(?:\/|$)/i;
const TRACKING_PARAMETERS = new Set([
  'uid', 'user_id', 'userid', 'client_id', 'visitor_id', 'device_id',
  'fbclid', 'gclid', 'ttclid', 'tracking_id'
]);

export function classifyHeuristic(analysis, observedSiteCount = 0, protectionLevel = 'balanced') {
  if (
    !analysis?.isThirdParty ||
    analysis.isTracker ||
    analysis.serviceType === 'service' ||
    !analysis.url
  ) {
    return { classification: 'NONE', confidence: 0, signals: [] };
  }

  let confidence = 0;
  const signals = [];

  try {
    const url = new URL(analysis.url);
    if (TRACKING_PATH.test(url.pathname)) {
      confidence += 0.4;
      signals.push('tracking-endpoint');
    }

    if ([...url.searchParams.keys()].some((key) =>
      TRACKING_PARAMETERS.has(key.toLowerCase())
    )) {
      confidence += 0.35;
      signals.push('tracking-identifier');
    }
  } catch {
    return { classification: 'NONE', confidence: 0, signals: [] };
  }

  if (analysis.type === 'ping') {
    confidence += 0.2;
    signals.push('beacon-request');
  }

  if (observedSiteCount >= 3) {
    confidence += 0.2;
    signals.push('cross-site-presence');
  }

  confidence = Math.min(confidence, 0.99);
  const possibleThreshold = protectionLevel === 'strict' ? 0.2 : 0.35;
  const classification = confidence >= 0.7
    ? 'LIKELY'
    : confidence >= possibleThreshold
      ? 'POSSIBLE'
      : 'NONE';

  return { classification, confidence, signals };
}