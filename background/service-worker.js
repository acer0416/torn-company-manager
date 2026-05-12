// Background Service Worker - handles alarms, notifications, periodic monitoring
// Runs independently even when popup is closed
// Compatible with both Chrome and Firefox (uses chrome.* which both support)

// Install handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('Torn Company Manager installed');
  // Set default settings
  chrome.storage.local.get('settings', (result) => {
    if (!result.settings) {
      chrome.storage.local.set({
        settings: {
          rehabMonitorEnabled: true,
          rehabCheckInterval: 30, // minutes
          notificationsEnabled: true,
          autoRefreshInterval: 60, // minutes
        }
      });
    }
  });
});

// Alarm-based periodic monitoring
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'rehab-monitor') {
    await checkRehabStatus();
  } else if (alarm.name === 'auto-refresh') {
    await refreshCompanyData();
  }
});

// Setup alarms on startup
chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
});

// Also setup alarms when service worker activates
setupAlarms();

async function setupAlarms() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;

  // Clear existing alarms
  await chrome.alarms.clearAll();

  if (settings.rehabMonitorEnabled) {
    chrome.alarms.create('rehab-monitor', {
      periodInMinutes: settings.rehabCheckInterval || 30
    });
  }

  if (settings.autoRefreshInterval > 0) {
    chrome.alarms.create('auto-refresh', {
      periodInMinutes: settings.autoRefreshInterval || 60
    });
  }
}

// Rehab status monitoring
async function checkRehabStatus() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return;

  try {
    // Get company employees
    const resp = await fetch(`https://api.torn.com/company/?selections=employees&key=${apiKey}`);
    const data = await resp.json();
    if (data.error) return;

    const employees = data.company_employees || {};
    const rehabAlerts = [];

    for (const [id, emp] of Object.entries(employees)) {
      // Check if traveling to Switzerland (state: Traveling, destination includes Swiss)
      if (emp.status && emp.status.state === 'Traveling') {
        const desc = emp.status.description || '';
        if (desc.includes('Switzerland') || desc.includes('瑞士')) {
          rehabAlerts.push({
            id: parseInt(id),
            name: emp.name,
            status: desc
          });

          // Record rehab event
          await recordRehabEvent(parseInt(id), emp.name);
        }
      }

      // Also check for high addiction levels
      if (emp.effectiveness && emp.effectiveness.addiction && emp.effectiveness.addiction <= -10) {
        chrome.notifications.create(`addiction-${id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '⚠️ 员工毒瘾警告',
          message: `${emp.name} 的毒瘾影响: ${emp.effectiveness.addiction}，建议关注`,
          priority: 1
        });
      }
    }

    // Send notification if rehab detected
    if (rehabAlerts.length > 0) {
      const names = rehabAlerts.map(a => a.name).join(', ');
      chrome.notifications.create('rehab-alert', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '🏥 Rehab 检测',
        message: `检测到员工正在前往瑞士: ${names}`,
        priority: 2
      });
    }
  } catch (err) {
    console.error('Rehab check failed:', err);
  }
}

// Record a rehab event in IndexedDB (same store as the rehab page reads)
async function recordRehabEvent(playerId, playerName) {
  const today = new Date().toISOString().slice(0, 10);
  const db = await openDB();
  const tx = db.transaction('rehab_records', 'readwrite');
  const store = tx.objectStore('rehab_records');

  // Check if we already recorded this trip today
  const existing = await new Promise((resolve) => {
    const req = store.index('date').getAll(today);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });

  const alreadyRecorded = existing.some(r => r.player_id === playerId);
  if (!alreadyRecorded) {
    store.put({
      player_id: playerId,
      player_name: playerName,
      date: today,
      timestamp: Math.floor(Date.now() / 1000),
      auto_detected: true
    });
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    console.log('Rehab recorded (IDB) for', playerName);
  }
  db.close();
}

// IndexedDB helper for service worker
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('torn-company-manager', 3);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Auto-refresh company data snapshot (writes to IndexedDB)
async function refreshCompanyData() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return;

  try {
    const resp = await fetch(`https://api.torn.com/company/?selections=profile,employees,stock,detailed&key=${apiKey}`);
    const data = await resp.json();
    if (data.error) return;

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = {
      date: today,
      timestamp: Math.floor(Date.now() / 1000),
      profile: data.company || {},
      employees: data.company_employees || {},
      stock: data.company_stock || {},
      detailed: data.company_detailed || {}
    };

    // Write to IndexedDB (same store the dashboard reads from)
    const db = await openDB();
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(snapshot);
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    db.close();
    console.log('Company snapshot saved (IDB) for', today);
  } catch (err) {
    console.error('Auto-refresh failed:', err);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'setupAlarms') {
    setupAlarms().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'checkRehab') {
    checkRehabStatus().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'refreshData') {
    refreshCompanyData().then(() => sendResponse({ ok: true }));
    return true;
  }
});
