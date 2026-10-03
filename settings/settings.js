const globalProtection = document.getElementById('globalProtection');
const protectionLevel = document.getElementById('protectionLevel');
const heuristicDetection = document.getElementById('heuristicDetection');
const allowlistedSites = document.getElementById('allowlistedSites');
const globalAllowlist = document.getElementById('globalAllowlist');
const blockedDomains = document.getElementById('blockedDomains');
const status = document.getElementById('status');
const ruleCapacityWarning = document.getElementById('ruleCapacityWarning');

async function sendAction(action, values = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...values });
  if (response?.success === false) throw new Error(response.message || 'Settings update failed.');
  return response;
}

function renderDomainList(container, domains, action, label) {
  container.replaceChildren();
  if (!domains.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No domains added.';
    container.append(empty);
    return;
  }

  for (const domain of domains) {
    const item = document.createElement('li');
    item.className = 'domain-item';
    const text = document.createElement('span');
    text.textContent = domain;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = label;
    remove.addEventListener('click', async () => {
      try {
        if (action === 'removeGlobalTracker') {
          const settings = await sendAction('getSettings');
          await sendAction('updateSettings', {
            settings: { globalAllowlist: settings.globalAllowlist.filter((value) => value !== domain) }
          });
        } else {
          await sendAction(action, { domain, siteDomain: domain, trusted: false, blocked: false });
        }
        await loadSettings();
        status.textContent = 'Updated.';
      } catch (error) { status.textContent = error.message; }
    });
    item.append(text, remove);
    container.append(item);
  }
}

async function loadSettings() {
  try {
    const settings = await sendAction('getSettings');
    globalProtection.checked = settings.globalProtection !== false;
    protectionLevel.value = settings.protectionLevel === 'strict' ? 'strict' : 'balanced';
    heuristicDetection.checked = settings.heuristicDetection !== false;
    renderDomainList(allowlistedSites, settings.allowlistedSites || [], 'trustSite', 'Remove trust');
    renderDomainList(globalAllowlist, settings.globalAllowlist || [], 'removeGlobalTracker', 'Remove allow');
    renderDomainList(blockedDomains, settings.blocklist || [], 'setTrackerBlockedGlobally', 'Unblock');
    if (settings.ruleCapacityWarning?.truncated) {
      const warning = settings.ruleCapacityWarning;
      ruleCapacityWarning.textContent =
        `Rule cap reached: ${warning.dropped} lower-priority rules were omitted. ` +
        `The internal limit is ${warning.limit}; some policy rules may be inactive.`;
      ruleCapacityWarning.hidden = false;
    } else {
      ruleCapacityWarning.textContent = '';
      ruleCapacityWarning.hidden = true;
    }
  } catch (error) {
    status.textContent = error.message || 'Could not load settings.';
  }
}

async function saveSettings(patch) {
  status.textContent = '';
  try {
    await sendAction('updateSettings', { settings: patch });
    await loadSettings();
    status.textContent = 'Saved.';
  } catch (error) {
    status.textContent = error.message || 'Could not save settings.';
  }
}

globalProtection.addEventListener('change', () => {
  saveSettings({ globalProtection: globalProtection.checked });
});
protectionLevel.addEventListener('change', () => {
  saveSettings({ protectionLevel: protectionLevel.value });
});
heuristicDetection.addEventListener('change', () => {
  saveSettings({ heuristicDetection: heuristicDetection.checked });
});

document.getElementById('resetSettings').addEventListener('click', async () => {
  if (!confirm('Reset protection settings and remove all site exceptions? Activity data will be kept.')) return;
  try {
    await sendAction('resetSettings');
    await loadSettings();
    status.textContent = 'Settings reset.';
  } catch (error) { status.textContent = error.message; }
});

document.getElementById('clearActivityData').addEventListener('click', async () => {
  if (!confirm('Clear request history, site and tracker counts, and heuristic observations?')) return;
  status.textContent = '';
  try {
    await sendAction('clearData');
    status.textContent = 'Activity data cleared.';
  } catch (error) {
    status.textContent = error.message || 'Could not clear activity data.';
  }
});

loadSettings();