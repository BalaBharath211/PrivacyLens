const elements = {
  siteDomain: document.getElementById('siteDomain'),
  siteState: document.getElementById('siteState'),
  globalProtection: document.getElementById('globalProtection'),
  siteProtection: document.getElementById('siteProtection'),
  trustSite: document.getElementById('trustSite'),
  trackerList: document.getElementById('trackerList'),
  pageBlocked: document.getElementById('pageBlocked'),
  blockedCount: document.getElementById('blockedCount'),
  allowedCount: document.getElementById('allowedCount'),
  flaggedCount: document.getElementById('flaggedCount'),
  trackerDetail: document.getElementById('trackerDetail'),
  errorMessage: document.getElementById('errorMessage')
};

let activeTab;
let popupData;
let selectedTracker;

async function sendAction(action, values = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...values });
  if (response?.success === false) throw new Error(response.message || 'Action failed.');
  return response;
}

function setError(message = '') {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = !message;
}

function trackerStatusClass(action) {
  if (action === 'BLOCKED') return 'status-blocked';
  if (action === 'FLAGGED') return 'status-flagged';
  return 'status-allowed';
}

function renderTrackers(trackers) {
  elements.trackerList.replaceChildren();
  if (!trackers.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No third-party activity recorded for this site yet.';
    elements.trackerList.append(empty);
    return;
  }

  const categoryOrder = [
    'Advertising', 'Analytics', 'Social Media', 'Fingerprinting', 'Utilities',
    'Hosting', 'Content', 'CDN', 'Unknown'
  ];
  const categories = new Map();
  for (const tracker of trackers) {
    if (!categories.has(tracker.category)) categories.set(tracker.category, []);
    categories.get(tracker.category).push(tracker);
  }

  const categoryNames = [...categories.keys()].sort((left, right) => {
    const leftIndex = categoryOrder.indexOf(left);
    const rightIndex = categoryOrder.indexOf(right);
    return (leftIndex < 0 ? categoryOrder.length : leftIndex) -
      (rightIndex < 0 ? categoryOrder.length : rightIndex);
  });

  for (const category of categoryNames) {
    const section = document.createElement('section');
    section.className = 'category-group';
    const heading = document.createElement('h3');
    heading.className = 'category-heading';
    heading.textContent = `${category} · ${categories.get(category).length}`;
    section.append(heading);

    for (const tracker of categories.get(category)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tracker-row';
      row.dataset.trackerId = tracker.id;

      const copy = document.createElement('span');
      copy.className = 'tracker-copy';
      const name = document.createElement('strong');
      name.textContent = tracker.trackerName;
      const domain = document.createElement('small');
      domain.textContent = tracker.domain;
      copy.append(name, domain);

      const count = document.createElement('span');
      count.className = 'tracker-count';
      count.textContent = String(tracker.requestCount);
      count.title = 'Recorded requests';

      const status = document.createElement('span');
      status.className = `status-tag ${trackerStatusClass(tracker.action)}`;
      status.textContent = tracker.action;
      row.append(copy, count, status);
      section.append(row);
    }
    elements.trackerList.append(section);
  }
}

async function refresh() {
  const detailWasOpen = !elements.trackerDetail.hidden;
  const selectedId = selectedTracker?.id;
  setError();
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    popupData = await sendAction('getPopupData', {
      url: activeTab?.url || '',
      tabId: activeTab?.id
    });

    elements.siteDomain.textContent = popupData.siteDomain || 'This page cannot be inspected';
    elements.globalProtection.checked = popupData.settings?.globalProtection !== false;
    elements.siteProtection.checked = popupData.settings?.sites?.[popupData.siteDomain]?.protectionEnabled !== false;
    elements.siteProtection.disabled = !popupData.siteDomain || popupData.siteTrusted;
    elements.trustSite.disabled = !popupData.siteDomain;
    elements.trustSite.textContent = popupData.siteTrusted ? 'Untrust this site' : 'Trust this site';
    elements.siteState.textContent = popupData.siteTrusted
      ? 'Trusted'
      : !popupData.settings?.globalProtection
        ? 'Protection off'
        : popupData.protectionEnabled ? 'Protected' : 'Paused';
    elements.pageBlocked.textContent = `${popupData.summary?.blockedThisPage || 0} blocked this page`;
    elements.blockedCount.textContent = String(popupData.summary?.blocked || 0);
    elements.allowedCount.textContent = String(popupData.summary?.allowed || 0);
    elements.flaggedCount.textContent = String(popupData.summary?.flagged || 0);
    renderTrackers(popupData.trackers || []);
    const refreshedTracker = popupData.trackers.find((tracker) => tracker.id === selectedId);
    if (detailWasOpen && refreshedTracker) showTrackerDetail(refreshedTracker);
    else elements.trackerDetail.hidden = true;
  } catch (error) {
    setError(error.message || 'Could not load site activity.');
    elements.trackerList.replaceChildren();
  }
}

function showTrackerDetail(tracker) {
  selectedTracker = tracker;
  document.getElementById('detailCategory').textContent = tracker.category || 'UNKNOWN';
  document.getElementById('detailName').textContent = tracker.trackerName || tracker.domain;
  document.getElementById('detailDomain').textContent = tracker.domain;
  document.getElementById('detailCompany').textContent = tracker.company || 'Unknown';
  document.getElementById('detailPurpose').textContent = tracker.purpose || 'Not classified';
  document.getElementById('detailRequests').textContent = String(tracker.requestCount);
  document.getElementById('detailStatus').textContent = tracker.action;

  const site = popupData.settings.sites[popupData.siteDomain] || {};
  const trackerAllowed = (site.allowedTrackers || []).some((value) =>
    value === tracker.id || value === tracker.domain
  );
  document.getElementById('allowTracker').textContent = trackerAllowed
    ? 'Remove site exception'
    : 'Allow on this site';
  document.getElementById('blockTracker').textContent = popupData.settings.blocklist
    .some((domain) => domain === tracker.id || domain === tracker.domain)
    ? 'Remove global block'
    : 'Block globally';
  elements.trackerDetail.hidden = false;
}

elements.globalProtection.addEventListener('change', async () => {
  try {
    await sendAction('setGlobalProtection', { enabled: elements.globalProtection.checked });
    await refresh();
  } catch (error) { setError(error.message); }
});

elements.siteProtection.addEventListener('change', async () => {
  try {
    await sendAction('setSiteProtection', {
      siteDomain: popupData.siteDomain,
      enabled: elements.siteProtection.checked
    });
    await refresh();
  } catch (error) { setError(error.message); }
});

elements.trustSite.addEventListener('click', async () => {
  try {
    await sendAction('trustSite', {
      siteDomain: popupData.siteDomain,
      trusted: !popupData.siteTrusted
    });
    await refresh();
  } catch (error) { setError(error.message); }
});

elements.trackerList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-tracker-id]');
  if (!row) return;
  const tracker = popupData.trackers.find((item) => item.id === row.dataset.trackerId);
  if (tracker) showTrackerDetail(tracker);
});

document.getElementById('detailBack').addEventListener('click', () => {
  elements.trackerDetail.hidden = true;
});

document.getElementById('allowTracker').addEventListener('click', async () => {
  if (!selectedTracker) return;
  const site = popupData.settings.sites[popupData.siteDomain] || {};
  const allowed = !(site.allowedTrackers || []).some((value) =>
    value === selectedTracker.id || value === selectedTracker.domain
  );
  try {
    await sendAction('setTrackerAllowed', {
      siteDomain: popupData.siteDomain,
      trackerId: selectedTracker.id,
      domain: selectedTracker.domain,
      allowed
    });
    await refresh();
  } catch (error) { setError(error.message); }
});

document.getElementById('blockTracker').addEventListener('click', async () => {
  if (!selectedTracker) return;
  const blockDomain = selectedTracker.id || selectedTracker.domain;
  const blocked = !popupData.settings.blocklist.some((domain) =>
    domain === selectedTracker.id || domain === selectedTracker.domain
  );
  try {
    await sendAction('setTrackerBlockedGlobally', {
      domain: blockDomain,
      blocked
    });
    await refresh();
  } catch (error) { setError(error.message); }
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === 'requestRecorded') refresh();
});

refresh();
