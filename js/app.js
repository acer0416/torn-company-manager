// Main App Initialization
(async function () {
  'use strict';

  // Global error handler - show errors on page
  window.onerror = function (msg, src, line, col, err) {
    console.error(`[Global] ${msg} at ${src}:${line}:${col}`, err);
    const container = document.getElementById('page-content');
    if (container && container.innerHTML.trim() === '') {
      container.innerHTML = `<div class="text-center text-red-400 py-10">
        <i class="fas fa-bug text-3xl mb-3"></i>
        <p class="font-mono text-sm">JS Error: ${msg}</p>
        <p class="text-xs text-gray-500 mt-1">${src}:${line}</p>
      </div>`;
    }
    return false;
  };

  window.addEventListener('unhandledrejection', function (e) {
    console.error('[Global] Unhandled promise rejection:', e.reason);
  });

  // Wait for DOM
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r));
  }

  // Detect popup mode and apply class
  const isPopup = !window.location.search.includes('mode=full') &&
                  (typeof chrome !== 'undefined' && chrome.extension && chrome.extension.getViews);
  if (isPopup) {
    document.documentElement.classList.add('is-popup');
    console.log('[App] Popup mode detected, is-popup class added');
  }

  console.log('[App] Starting initialization...');

  // Initialize DB
  try {
    await DB.init();
    console.log('[App] DB initialized');
  } catch (err) {
    console.error('[App] DB init failed:', err);
    Utils.toast('数据库初始化失败: ' + err.message, 'error');
  }

  // Check API key
  let hasKey = false;
  try {
    const key = await TornAPI.getKey();
    hasKey = !!key;
    console.log('[App] API key:', hasKey ? 'present' : 'missing');
  } catch (e) {
    console.error('[App] Cannot check API key:', e);
  }

  // Register all pages
  const pageMap = {
    'dashboard': typeof DashboardPage !== 'undefined' ? DashboardPage : null,
    'employees': typeof EmployeePage !== 'undefined' ? EmployeePage : null,
    'training': typeof TrainingPage !== 'undefined' ? TrainingPage : null,
    'training-planner': typeof TrainingPlannerPage !== 'undefined' ? TrainingPlannerPage : null,
    'stock': typeof StockPage !== 'undefined' ? StockPage : null,
    'finance': typeof FinancePage !== 'undefined' ? FinancePage : null,
    'rehab': typeof RehabPage !== 'undefined' ? RehabPage : null,
    'boost': typeof BoostPage !== 'undefined' ? BoostPage : null,
    'settings': typeof SettingsPage !== 'undefined' ? SettingsPage : null,
  };

  for (const [name, page] of Object.entries(pageMap)) {
    if (page) {
      Router.register(name, page);
      console.log(`[App] Registered page: ${name}`);
    } else {
      console.warn(`[App] Page '${name}' not loaded`);
      Router.register(name, {
        init() { },
        render() {
          document.getElementById('page-content').innerHTML =
            `<div class="text-center text-gray-500 py-20">
              <i class="fas fa-exclamation-triangle text-3xl mb-3"></i>
              <p>页面模块 '${name}' 未加载</p>
            </div>`;
        }
      });
    }
  }

  // If no API key, go to settings
  if (!hasKey) {
    console.log('[App] No API key, redirecting to settings');
    window.location.hash = '#/settings';
    Utils.toast('请先设置 API Key', 'warning');
  } else {
    // Load company info into header (non-blocking) — 使用统一的 companyData 缓存储
    AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData()).then(data => {
      if (data && data.profile) {
        const companyName = data.profile.name || 'Unknown';
        const rating = data.profile.rating || 0;
        document.getElementById('header-company-name').textContent = `${companyName} (${rating}⭐)`;
        document.getElementById('header-company').classList.remove('hidden');
        document.getElementById('header-status').classList.remove('hidden');
        console.log('[App] Company loaded:', companyName);
      }
    }).catch(err => {
      console.warn('[App] Failed to load company data:', err);
    });
  }

  // Initialize router
  Router.init();

  // Header buttons
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    Utils.showLoading('刷新中...');
    try {
      // 清除公司/库存缓存，强制重新获取
      AppCache.invalidate('companyData');
      AppCache.invalidate('stock');
      const data = await AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData());
      const today = Utils.todayKey();
      // 恢复 object 格式以兼容快照存储
      const employees = {};
      (data.employees || []).forEach(emp => { employees[emp.id || emp.player_id] = emp; });
      const stock = {};
      (data.stock || []).forEach(item => { stock[item.name] = item; });
      await DB.put('snapshots', {
        date: today,
        timestamp: Math.floor(Date.now() / 1000),
        profile: data.profile || {},
        employees: employees,
        stock: stock,
        detailed: data.detailed || {}
      });
      Utils.toast('刷新成功', 'success');
      Router.refresh();
    } catch (err) {
      Utils.toast('刷新失败: ' + err.message, 'error');
    } finally {
      Utils.hideLoading();
    }
  });

  document.getElementById('btn-open-full')?.addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html?mode=full') });
    } catch (e) {
      const separator = window.location.href.includes('?') ? '&' : '?';
      window.open(window.location.href + separator + 'mode=full', '_blank');
    }
  });

  document.getElementById('btn-settings')?.addEventListener('click', () => {
    window.location.hash = '#/settings';
  });

  // Background service worker messages
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'REFRESH_DATA') Router.refresh();
    });
  } catch (e) { }

  // Modal close handlers
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) Utils.hideModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') Utils.hideModal();
  });

  console.log('[App] Initialization complete');
})();
