// popup.js
import { getAllItems, OBJECT_STORE_REQUESTS } from '../storage/indexedDB.js';

document.addEventListener("DOMContentLoaded", async () => {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    document.getElementById("currentUrl").textContent = tab.url;
  } else {
    document.getElementById("currentUrl").textContent = "N/A";
  }

  const updateTrackerCount = async () => {
    try {
      const allRequests = await getAllItems(OBJECT_STORE_REQUESTS);
      const blockedRequests = allRequests.filter(request => request.blocked).length;
      document.getElementById("trackerCount").textContent = blockedRequests;
    } catch (error) {
      document.getElementById("trackerCount").textContent = "Error";
      console.error("Error getting tracker summary:", error);
    }
  };

  updateTrackerCount();

  // Button actions
  document.getElementById("viewDetails").addEventListener("click", () => {
    chrome.tabs.create({ url: "../dashboard/dashboard.html" });
  });

  document.getElementById("clearDataButton").addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all stored data? This cannot be undone.")) {
      try {
        const response = await chrome.runtime.sendMessage({ action: "clearAllData" });
        if (response && response.success) {
          alert("All data cleared successfully!");
          updateTrackerCount();
        } else {
          alert("Failed to clear data: " + (response?.message || "Unknown error"));
        }
      } catch (error) {
        console.error("Error clearing data:", error);
        alert("Error clearing data. Check console.");
      }
    }
  });

  // Optional footer button (future settings)
  document.getElementById("settingsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Footer links (optional behavior)
  document.getElementById("openDashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: "../dashboard/dashboard.html" });
  });

  document.getElementById("privacyPolicy").addEventListener("click", () => {
    chrome.tabs.create({ url: "../settings/settings.html" });
  });
});
