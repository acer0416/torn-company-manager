// Browser API compatibility layer
// Firefox uses browser.* API, Chrome uses chrome.*
// This provides a unified API for both
if (typeof browser === 'undefined') {
  // Chrome - chrome.* is already available
  window.browser = chrome;
} else {
  // Firefox - browser.* is the native API
  // chrome.* also works but browser.* supports promises natively
}
