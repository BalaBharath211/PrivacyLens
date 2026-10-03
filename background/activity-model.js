export function classifyActivityRecord(record = {}) {
  if (record.isTracker) return 'Known tracker';
  if (record.serviceType === 'service') return 'Known service';
  if (record.action === 'FLAGGED') return 'Heuristic flag';
  if (record.action === 'BLOCKED') return 'Unlisted (blocklist)';
  return 'Ordinary third-party request';
}

export function getActivityCategory(record = {}) {
  const classification = classifyActivityRecord(record);
  const category = record.category || 'Unknown';
  return classification === 'Unlisted (blocklist)' && category === 'Unknown'
    ? 'Unlisted (blocklist)'
    : category;
}

export function buildActivitySummary(siteAggregate, recentRequests) {
  return {
    totalBlocked: siteAggregate?.blockedCount || 0,
    totalDetected: siteAggregate?.requestCount || 0,
    recentActivityCount: recentRequests.length
  };
}