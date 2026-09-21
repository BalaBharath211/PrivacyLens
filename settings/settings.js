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
// Get references to our HTML elements
const heuristicToggle = document.getElementById('heuristic-toggle');
const dynamicDomainList = document.getElementById('dynamic-domain-list');

// Function to load and display the dynamically added rules
const loadDynamicRules = async () => {
    // Clear the current list to prevent duplicates on reload
    dynamicDomainList.innerHTML = '';

    const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();

    if (dynamicRules.length === 0) {
        dynamicDomainList.innerHTML = '<li>No domains have been blocked by the heuristic engine yet.</li>';
        return;
    }

    // Get the allowlist to check if a rule is technically still active but should be ignored
    const { allowlist = [] } = await chrome.storage.local.get('allowlist');

    dynamicRules.forEach(rule => {
        // We assume the domain is stored in the rule's condition
        const domain = normalizeHostname(rule.condition.urlFilter);
        if (!domain) return;        
        // Skip rendering if this domain is already on the allowlist
        if(allowlist.includes(domain)) return;

        const listItem = document.createElement('li');
        listItem.className = 'domain-item';

        const domainSpan = document.createElement('span');
        domainSpan.textContent = domain;

        const allowButton = document.createElement('button');
        allowButton.textContent = 'Allow';
        allowButton.className = 'allow-btn';
        // Store the rule ID and domain on the button itself for easy access
        allowButton.dataset.ruleId = rule.id;
        allowButton.dataset.domain = domain;
        
        allowButton.addEventListener('click', handleAllowDomain);

        listItem.appendChild(domainSpan);
        listItem.appendChild(allowButton);
        dynamicDomainList.appendChild(listItem);
    });
};

// Function to handle the "Allow" button click
const handleAllowDomain = async (event) => {
  const { ruleId, domain: rawDomain } = event.target.dataset;
  const domain = normalizeHostname(rawDomain);

  if (!domain) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [parseInt(ruleId, 10)]
  });

  const { allowlist = [], dynamicallyAddedRules = {} } =
    await chrome.storage.local.get([
      'allowlist',
      'dynamicallyAddedRules'
    ]);

  const normalizedAllowlist = [
    ...new Set(allowlist.map(normalizeHostname).filter(Boolean))
  ];

  if (!normalizedAllowlist.includes(domain)) {
    normalizedAllowlist.push(domain);
  }

  for (const key of Object.keys(dynamicallyAddedRules)) {
    if (normalizeHostname(key) === domain) {
      delete dynamicallyAddedRules[key];
    }
  }

  await chrome.storage.local.set({
    allowlist: normalizedAllowlist,
    dynamicallyAddedRules
  });

  loadDynamicRules();
};

// Main function to initialize the page
const initializeSettings = async () => {
    // Load and set the current state of the heuristic toggle
    const { isHeuristicEngineEnabled = true } = await chrome.storage.local.get('isHeuristicEngineEnabled');
    heuristicToggle.checked = isHeuristicEngineEnabled;

    // Add event listener for the toggle
    heuristicToggle.addEventListener('change', () => {
        chrome.storage.local.set({ isHeuristicEngineEnabled: heuristicToggle.checked });
    });

    // Load the list of dynamically blocked domains
    loadDynamicRules();
};

// Run the initialization function when the document is loaded
document.addEventListener('DOMContentLoaded', initializeSettings);