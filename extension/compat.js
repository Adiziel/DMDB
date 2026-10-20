// Chromium exposes `chrome.*` (promise-based in Manifest V3); Firefox exposes `browser.*`
// (promise-based). Use `api.*` everywhere and always the promise style.
var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
