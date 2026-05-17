// Background Service Worker - handles alarms, notifications, periodic monitoring
// Runs independently even when popup is closed
// Compatible with both Chrome and Firefox (uses chrome.* which both support)

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
      seller.total_points = (seller.total_points || 0) + 10;
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
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('torn-company-manager', 8);
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
  if (msg.action === 'scrapeTraining') {
    scrapeTrainingFromPage().then((result) => sendResponse(result)).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === 'getTrainingSnapshot') {
    getTrainingSnapshot().then((result) => sendResponse(result)).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // 接收来自 content script 的抓取结果
  if (msg.action === 'trainingDataScraped') {
    saveTrainingSnapshot(msg.data).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ---- 训练数据抓取 ----

/**
 * 从 Torn 公司页面抓取训练数据
 * 流程：
 * 1. 查找已打开的 Torn 公司页面 tab
 * 2. 如果没找到，打开一个新 tab
 * 3. 向该 tab 的 content script 发送 scrape-training-data 消息
 * 4. content script 在页面上点击 Training 按钮并解析数据
 * 5. 将结果存入 IndexedDB
 */
async function scrapeTrainingFromPage() {
  // Step 1: 查找已打开的 Torn 公司页面
  let tabs = await chrome.tabs.query({
    url: 'https://www.torn.com/companies.php*'
  });

  let targetTab = null;

  if (tabs.length > 0) {
    // 优先使用活跃的 tab
    targetTab = tabs.find(t => t.active) || tabs[0];
    console.log('[ScrapeTraining] Found existing tab:', targetTab.id, targetTab.url);
  } else {
    // Step 2: 没有找到，创建新 tab
    console.log('[ScrapeTraining] No existing tab found, creating new one...');
    targetTab = await chrome.tabs.create({
      url: 'https://www.torn.com/companies.php?step=your&type=1',
      active: false // 后台打开，不干扰用户
    });

    // 等待页面加载完成
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === targetTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 超时保护：30 秒
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });

    // 额外等待确保 content script 注入并初始化
    await new Promise(r => setTimeout(r, 2000));
  }

  // Step 3: 向 content script 发送抓取命令
  try {
    const response = await chrome.tabs.sendMessage(targetTab.id, {
      action: 'scrape-training-data'
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'Content script 返回错误');
    }

    // Step 4: 存入 IndexedDB
    await saveTrainingSnapshot(response.data);

    return {
      ok: true,
      count: response.data.count,
      scrapedAt: response.data.scrapedAt,
      source: response.data.source
    };
  } catch (err) {
    // 如果 content script 未响应，可能是页面还没准备好
    console.error('[ScrapeTraining] Failed to communicate with content script:', err);
    throw new Error(`无法与 Torn 页面通信: ${err.message}。请确保 Torn 公司页面已打开并登录。`);
  }
}

/**
 * 将抓取的训练数据存入 IndexedDB
 * 存储到 training_snapshots store
 */
async function saveTrainingSnapshot(data) {
  const db = await openDB();
  const tx = db.transaction('training_snapshots', 'readwrite');
  const store = tx.objectStore('training_snapshots');

  const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    timestamp: Date.now(),
    count: data.count || 0,
    entries: data.entries || [],
    source: data.source || 'unknown',
    scrapedAt: data.scrapedAt || Date.now()
  };

  store.put(snapshot);
  await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
  db.close();
  console.log('[ScrapeTraining] Snapshot saved to IDB:', snapshot.count, 'entries');
}

/**
 * 获取最新的训练快照
 */
async function getTrainingSnapshot() {
  try {
    const db = await openDB();
    const tx = db.transaction('training_snapshots', 'readonly');
    const store = tx.objectStore('training_snapshots');
    const all = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    db.close();

    // 返回最新的快照
    if (all.length === 0) {
      return { ok: true, snapshot: null };
    }

    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return { ok: true, snapshot: all[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
