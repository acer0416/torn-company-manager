// Content Script for Torn Company page
(function () {
  'use strict';

  console.log("[TCM] Content script loaded! URL:", window.location.href);

  let observer = null;
  let pendingFillData = null;

  // Helper to extract the tcm_fill parameter from either search or hash
  function getTcmFillParam() {
    // 1. Try search parameters
    const urlParams = new URLSearchParams(window.location.search);
    let val = urlParams.get("tcm_fill");
    if (val) {
      console.log("[TCM] Found tcm_fill in search query string.");
      return val;
    }

    // 2. Try hash parameters
    const hash = window.location.hash;
    const match = hash.match(/[?&]tcm_fill=([^&]+)/);
    if (match) {
      console.log("[TCM] Found tcm_fill in hash part.");
      return match[1];
    }
    return null;
  }

  // Parse and clean URL parameters on page load
  const tcmFillParam = getTcmFillParam();
  if (tcmFillParam) {
    try {
      console.log("[TCM] Raw tcm_fill parameter:", tcmFillParam);
      // Decode URL encoding recursively to restore '+' and other characters (handles single/double/triple encoding)
      let decodedParam = tcmFillParam;
      while (decodedParam.includes('%')) {
        decodedParam = decodeURIComponent(decodedParam);
      }
      console.log("[TCM] URL decoded parameter:", decodedParam);
      // Decode Base64 safely (handles UTF-8)
      const jsonStr = decodeURIComponent(escape(atob(decodedParam)));
      pendingFillData = JSON.parse(jsonStr);
      console.log("[TCM] Successfully decoded pending fill data:", pendingFillData);

      // Immediately clear the parameter from the address bar history (both search and hash)
      const url = new URL(window.location.href);
      if (url.searchParams.has("tcm_fill")) {
        url.searchParams.delete("tcm_fill");
      }
      if (url.hash.includes("tcm_fill")) {
        url.hash = url.hash.replace(/[?&]tcm_fill=[^&]+/g, '');
        // Clean up trailing ? or & from hash
        url.hash = url.hash.replace(/[?&]$/, '');
      }
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      console.log("[TCM] Cleaned URL parameters successfully.");
    } catch (e) {
      console.error("[TCM] Failed to parse tcm_fill parameter:", e);
    }
  } else {
    console.log("[TCM] No pending tcm_fill parameter found in URL.");
  }

  // Update React input values programmatically
  function updateReactInput(input, value) {
    if (!input) return;
    const valueString = value.toString();
    input.value = valueString;
    // Dispatch input and change events so React state updates
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Fill stock with target quantities from fillData
  function fillStockWithData(stockList, fillData) {
    console.log("[TCM] Auto-filling stock fields...");
    const stockItems = stockList.querySelectorAll("li:not(.total):not(.quantity)");
    console.log("[TCM] Found stock item rows:", stockItems.length);
    
    let filledCount = 0;
    stockItems.forEach((stockItem, idx) => {
      // Find item name
      const nameElement = stockItem.querySelector(".name");
      if (!nameElement) {
        console.warn(`[TCM] Row #${idx} does not contain .name element.`);
        return;
      }

      const itemName = nameElement.textContent.replace(/\s+/g, ' ').trim();
      if (!itemName) return;

      const targetQty = fillData[itemName];
      console.log(`[TCM] Item row name: "${itemName}". Target qty from parameter:`, targetQty);

      if (targetQty !== undefined && targetQty >= 0) {
        const input = stockItem.querySelector(".quantity input") || 
                      stockItem.querySelector("input.input-money") || 
                      stockItem.querySelector("input[type='text']");
        if (input) {
          updateReactInput(input, targetQty);
          filledCount++;
          console.log(`[TCM] Filled "${itemName}" with quantity:`, targetQty);
        } else {
          console.warn(`[TCM] Could not find input element for "${itemName}".`);
        }
      }
    });
    console.log(`[TCM] Done auto-filling. Filled ${filledCount} items.`);
    return filledCount;
  }

  // Check and run auto-fill on the page
  function checkAndFill() {
    if (pendingFillData) {
      const stockList = document.querySelector(".stock-list");
      if (stockList) {
        console.log("[TCM] .stock-list detected, triggering fill operation.");
        const filledCount = fillStockWithData(stockList, pendingFillData);
        if (filledCount > 0) {
          pendingFillData = null; // Clear so we only fill once
          console.log("[TCM] pendingFillData successfully consumed.");
        }
      }
    }
  }

  // Set up observer to handle SPA rendering of stock management page
  function initObserver() {
    if (observer) return;

    const targetNode = document.getElementById('content-wrapper') || document.body;
    if (!targetNode) {
      console.error("[TCM] Target node for MutationObserver not found!");
      return;
    }

    console.log("[TCM] Setting up MutationObserver on:", targetNode.id || targetNode.tagName);
    observer = new MutationObserver(() => {
      checkAndFill();
    });

    observer.observe(targetNode, {
      childList: true,
      subtree: true
    });

    // Check once immediately
    checkAndFill();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
})();
