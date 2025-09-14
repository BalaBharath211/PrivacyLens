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
      const trackerCount = allRequests.length;
      document.getElementById("trackerCount").textContent = trackerCount;
    } catch (error) {
      document.getElementById("trackerCount").textContent = "Error";
      console.error("Error getting tracker summary:", error);
    }
  };

  updateTrackerCount();

  document.getElementById("viewDetails").addEventListener("click", () => {
    chrome.tabs.create({ url: "../dashboard/dashboard.html" });
  });

  const clearDataButton = document.getElementById("clearDataButton");
  if (clearDataButton) {
    clearDataButton.addEventListener("click", async () => {
      if (confirm("Are you sure you want to clear ALL privacy data collected by this extension? This cannot be undone.")) {
        try {
          const response = await chrome.runtime.sendMessage({ action: "clearAllData" });
          if (response && response.success) {
            alert("All data cleared successfully!");
            updateTrackerCount();
          } else {
            const errorMessage = (response && response.message) || "Unknown error.";
            alert("Failed to clear data: " + errorMessage);
          }
        } catch (error) {
          console.error("Error sending clear data message:", error);
          alert("Error clearing data. Check console.");
        }
      }
    });
  }
});