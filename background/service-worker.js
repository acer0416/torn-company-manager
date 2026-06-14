// Background Service Worker - handles alarms, notifications, periodic monitoring
// Runs independently even when popup is closed

// Open app in new tab when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html') });
});

// Install handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('Torn Company Manager installed');
  // Set default settings (flat keys)
  chrome.storage.local.get('monitoringEnabled', (result) => {
    if (result.monitoringEnabled === undefined) {
      chrome.storage.local.set({
        monitoringEnabled: true,
        checkInterval: 30, // minutes
        notificationsEnabled: true,
        refreshInterval: 60  // minutes
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
  } else if (alarm.name === 'boost-points-regen') {
    await regenerateBoostSellerPoints();
  } else if (alarm.name === 'industry-refresh') {
    await refreshIndustryData();
  }
});

// Setup alarms on startup
chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
});

// Also setup alarms when service worker activates
setupAlarms();

function msUntilNext2AM() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function msUntilBeijing2AM15() {
  const now = new Date();
  // Beijing = UTC+8, so 2:15 AM Beijing = 18:15 UTC previous day
  const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
  const utcDate = new Date(utcNow);
  const target = new Date(utcDate);
  target.setUTCHours(18, 15, 0, 0); // 18:15 UTC = 02:15 Beijing
  if (target <= utcDate) target.setDate(target.getDate() + 1);
  return target - utcDate;
}

async function setupAlarms() {
  const items = await chrome.storage.local.get([
    'monitoringEnabled',
    'checkInterval',
    'refreshInterval'
  ]);

  // Clear existing alarms
  await chrome.alarms.clearAll();

  if (items.monitoringEnabled) {
    chrome.alarms.create('rehab-monitor', {
      periodInMinutes: items.checkInterval || 30
    });
  }

  if (items.refreshInterval > 0) {
    chrome.alarms.create('auto-refresh', {
      periodInMinutes: items.refreshInterval || 60
    });
  }

  chrome.alarms.create('boost-points-regen', {
    delayInMinutes: Math.max(1, msUntilNext2AM() / 60000),
    periodInMinutes: 24 * 60
  });

  // Industry data refresh: daily at 2:15 AM Beijing time (UTC+8 = 18:15 UTC)
  chrome.alarms.create('industry-refresh', {
    delayInMinutes: msUntilBeijing2AM15() / 60000,
    periodInMinutes: 24 * 60
  });
}

/** 每日凌晨 2 点：有总点数的 Boost 卖家自动 +10 点 */
async function regenerateBoostSellerPoints() {
  const hour = new Date().getHours();
  if (hour !== 2) return;

  try {
    const db = await openDB();
    const tx = db.transaction('boost_sellers', 'readwrite');
    const store = tx.objectStore('boost_sellers');
    const all = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    const today = new Date().toISOString().slice(0, 10);
    for (const seller of all) {
      if ((seller.total_points || 0) <= 0) continue;
      if (seller.last_regen_date === today) continue;
      seller.total_points = (seller.total_points || 0) + 10; // BOOST_DAILY_REGEN (constants.js not available in SW scope)
      seller.last_regen_date = today;
      seller.last_updated = Date.now();
      store.put(seller);
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    db.close();
    console.log('[Boost] Daily +10 points applied where applicable');
  } catch (err) {
    console.error('[Boost] regenerateBoostSellerPoints failed:', err);
  }
}

// Rehab status monitoring
async function checkRehabStatus() {
  const { apiKey, dash_addiction_threshold, addiction_alerts_history } = await chrome.storage.local.get([
    'apiKey',
    'dash_addiction_threshold',
    'addiction_alerts_history'
  ]);
  if (!apiKey) return;

  const threshold = Math.abs(Number(dash_addiction_threshold)) || 5;
  const today = new Date().toISOString().slice(0, 10);

  // 获取今天已经去过瑞士康复的员工ID列表
  let rehabbedTodayIds = new Set();
  try {
    const db = await openDB();
    const tx = db.transaction('rehab_records', 'readonly');
    const store = tx.objectStore('rehab_records');
    const allRehabs = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    db.close();
    
    allRehabs
      .filter(r => r.date === today)
      .forEach(r => rehabbedTodayIds.add(String(r.player_id)));
  } catch (err) {
    console.error('Failed to load rehabbed players today:', err);
  }

  try {
    // Get company employees
    const resp = await fetch(`https://api.torn.com/company/?selections=employees&key=${apiKey}`);
    const data = await resp.json();
    if (data.error) return;

    const employees = data.company_employees || {};
    const rehabAlerts = [];
    const alertsHistory = addiction_alerts_history || {};
    const updatedHistory = {};

    for (const [id, emp] of Object.entries(employees)) {
      // 保持历史记录中仅包含当前在职员工，防止离职员工垃圾数据堆积
      if (alertsHistory[id]) {
        updatedHistory[id] = alertsHistory[id];
      }

      // Check if traveling to Switzerland (state: Traveling, destination includes Swiss)
      const isTravelingToSwiss = emp.status && 
                                 emp.status.state === 'Traveling' && 
                                 (emp.status.description?.includes('Switzerland') || emp.status.description?.includes('瑞士'));

      if (isTravelingToSwiss) {
        rehabAlerts.push({
          id: parseInt(id),
          name: emp.name,
          status: emp.status.description || ''
        });

        // Record rehab event
        await recordRehabEvent(parseInt(id), emp.name);
        // 动态加入今日已去过瑞士名单，防止后续重复报警
        rehabbedTodayIds.add(String(id));
      }

      const hasRehabbedToday = rehabbedTodayIds.has(String(id));

      // Also check for high addiction levels
      // 仅当员工今天没有去过瑞士（或不在去瑞士路上）时，才推送毒瘾弹窗提醒，提醒冷却为 6 小时
      if (!isTravelingToSwiss && !hasRehabbedToday && emp.effectiveness && emp.effectiveness.addiction && emp.effectiveness.addiction <= -threshold) {
        const now = Date.now();
        const lastAlertTime = alertsHistory[id] || 0;
        const cooldownMs = 6 * 60 * 60 * 1000; // 6小时间隔

        if (now - lastAlertTime >= cooldownMs) {
          chrome.notifications.create(`addiction-${id}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: '⚠️ 员工毒瘾警告',
            message: `${emp.name} 的毒瘾影响: ${emp.effectiveness.addiction}，建议关注`,
            priority: 1
          });
          updatedHistory[id] = now;
        }
      }
    }

    // 保存更新后的警报历史记录
    await chrome.storage.local.set({ addiction_alerts_history: updatedHistory });

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
// 去重策略：player_id + date 联合检查（与 rehab.js 保持一致）
async function recordRehabEvent(playerId, playerName) {
  const today = new Date().toISOString().slice(0, 10);
  const db = await openDB();
  const tx = db.transaction('rehab_records', 'readwrite');
  const store = tx.objectStore('rehab_records');

  // 使用 player_id 索引获取该玩家所有记录，再按日期去重
  const existing = await new Promise((resolve) => {
    const req = store.index('player_id').getAll(playerId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });

  const alreadyRecorded = existing.some(r => r.date === today);
  if (!alreadyRecorded) {
    store.put({
      player_id: playerId,
      player_name: playerName,
      date: today,
      timestamp: Date.now(),
      auto_detected: true
    });
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    console.log('Rehab recorded (IDB) for', playerName);
  }
  db.close();
}

// IndexedDB helper for service worker
// NOTE: DB version must match js/db.js DB_VERSION (currently 12)
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('torn-company-manager', 12);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      console.log('[SW] IndexedDB upgrade from v' + oldVersion + ' to v' + db.version);

      // Create stores if they don't exist (idempotent across upgrades)
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('rehab_records')) {
        const rehabStore = db.createObjectStore('rehab_records', { keyPath: 'id', autoIncrement: true });
        rehabStore.createIndex('player_id', 'player_id', { unique: false });
        rehabStore.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('boost_sellers')) {
        db.createObjectStore('boost_sellers', { keyPath: 'id', autoIncrement: true });
      }
      // Train fund allocations (v9)
      if (!db.objectStoreNames.contains('train_fund_allocations')) {
        const tfaStore = db.createObjectStore('train_fund_allocations', { keyPath: 'id' });
        tfaStore.createIndex('employeeId', 'employeeId', { unique: false });
        tfaStore.createIndex('weekKey', 'weekKey', { unique: false });
        tfaStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      // Industry companies (v12)
      if (!db.objectStoreNames.contains('industry_companies')) {
        const icStore = db.createObjectStore('industry_companies', { keyPath: 'CompanyID' });
        icStore.createIndex('industry_id', 'industry_id');
      }
      if (!db.objectStoreNames.contains('industry_meta')) {
        db.createObjectStore('industry_meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Auto-refresh company data snapshot (writes to IndexedDB)
async function refreshCompanyData() {
const { apiKey } = await chrome.storage.local.get('apiKey');
if (!apiKey) return;

await checkAndSaveBus2110Education(apiKey);

try {
  const resp = await fetch(`https://api.torn.com/company/?selections=profile,employees,stock,detailed&key=${apiKey}`);
  const data = await resp.json();
  if (data.error) return;

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {
    date: today,
    timestamp: Date.now(),
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

// Industry company data refresh (daily at 2:15 AM Beijing time)
async function refreshIndustryData() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return;

  try {
    // Detect user's company type
    const profileResp = await fetch(`https://api.torn.com/company/?selections=profile&key=${apiKey}`);
    const profileData = await profileResp.json();
    if (profileData.error) return;
    const companyType = profileData?.company?.company_type;
    if (!companyType) return;

    // Fetch all companies in the industry
    const allCompanies = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const resp = await fetch(`https://api.torn.com/v2/company/${companyType}/companies?limit=${limit}&offset=${offset}&striptags=false&key=${apiKey}`);
      const data = await resp.json();
      if (data.error) break;
      const companies = data.companies || [];
      allCompanies.push(...companies);
      if (!data._metadata?.links?.next || companies.length === 0) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 650));
    }

    if (allCompanies.length === 0) return;

    // Process and store
    const db = await openDB();
    const tx = db.transaction(['industry_companies', 'industry_meta'], 'readwrite');
    const icStore = tx.objectStore('industry_companies');
    const metaStore = tx.objectStore('industry_meta');

    // Clear old data for this industry
    const idx = icStore.index('industry_id');
    const existing = await new Promise(resolve => {
      const req = idx.getAll(companyType);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    for (const row of existing) {
      icStore.delete(row.CompanyID);
    }

    // Insert new data
    for (const c of allCompanies) {
      const director = c.director || {};
      icStore.put({
        CompanyID: c.id || 0,
        industry_id: companyType,
        Name: c.name || 'Unknown',
        DirectorName: (director != null && typeof director === 'object' ? director.name : director) || 'Unknown',
        DirectorID: (director != null && typeof director === 'object' ? (director.id ?? director.player_id) : null) || null,
        Stars: c.rating || 0,
        Daily_Income: c.income?.daily || 0,
        Weekly_Income: c.income?.weekly || 0,
        Daily_Customers: c.customers?.daily || 0,
        Weekly_Customers: c.customers?.weekly || 0,
        Employees_Hired: c.employees?.hired || 0,
        Employees_Capacity: c.employees?.capacity || 0,
        Days_Old: c.days_old || 0
      });
    }

    metaStore.put({ key: 'last_update', value: Date.now() });
    metaStore.put({ key: 'industry_id', value: companyType });
    metaStore.put({ key: 'company_count', value: allCompanies.length });

    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    db.close();
    console.log(`[SW] Industry data refreshed: ${allCompanies.length} companies in industry ${companyType}`);
  } catch (err) {
    console.error('[SW] Industry refresh failed:', err);
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
  if (msg.action === 'refreshIndustry') {
    refreshIndustryData().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function checkAndSaveBus2110Education(apiKey) {
  try {
    const { has_bus2110 } = await chrome.storage.local.get('has_bus2110');
    if (has_bus2110 === true) {
      return;
    }
    const resp = await fetch(`https://api.torn.com/v2/user/education?key=${apiKey}`);
    const eduData = await resp.json();
    if (eduData && eduData.education && Array.isArray(eduData.education.complete)) {
      if (eduData.education.complete.includes(11)) { // EDUCATION_IDS.BUS2110 (constants.js not available in SW scope)
        await chrome.storage.local.set({ has_bus2110: true });
        // Also write to IndexedDB settings store
        try {
          const db = await openDB();
          const tx = db.transaction('settings', 'readwrite');
          tx.objectStore('settings').put({ key: 'has_bus2110', value: true });
          await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
          db.close();
        } catch (dbErr) {
          console.error('[SW] Failed to write has_bus2110 to IndexedDB:', dbErr);
        }
        console.log('[SW] Education BUS2110 detected and saved to persistent storage.');
      }
    }
  } catch (err) {
    console.error('[SW] checkAndSaveBus2110Education failed:', err);
  }
}
