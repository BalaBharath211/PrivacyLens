import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildActivitySummary,
  classifyActivityRecord,
  getActivityCategory
} from '../background/activity-model.js';

test('activity records receive one explicit classification', () => {
  assert.equal(classifyActivityRecord({ isTracker: true, action: 'BLOCKED' }), 'Known tracker');
  assert.equal(classifyActivityRecord({ serviceType: 'service', action: 'ALLOWED' }), 'Known service');
  assert.equal(classifyActivityRecord({ action: 'BLOCKED' }), 'Unlisted (blocklist)');
  assert.equal(classifyActivityRecord({ action: 'FLAGGED' }), 'Heuristic flag');
  assert.equal(classifyActivityRecord({ action: 'possibleBlock' }), 'Ordinary third-party request');
  assert.equal(classifyActivityRecord({ action: 'ALLOWED' }), 'Ordinary third-party request');
});

test('blocked unlisted activity never uses the Unknown category label', () => {
  assert.equal(
    getActivityCategory({ action: 'BLOCKED', category: 'Unknown' }),
    'Unlisted (blocklist)'
  );
  assert.equal(
    getActivityCategory({ action: 'ALLOWED', category: 'Unknown' }),
    'Unknown'
  );
});

test('aggregate totals and recent retained-row counts stay in separate windows', () => {
  const summary = buildActivitySummary(
    { blockedCount: 8, requestCount: 53 },
    [{ id: 4 }, { id: 3 }]
  );

  assert.deepEqual(summary, {
    totalBlocked: 8,
    totalDetected: 53,
    recentActivityCount: 2
  });
});