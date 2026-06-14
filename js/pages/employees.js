// Employees Page - 员工管理
window.EmployeePage = (() => {
  let employees = [];
  let notes = {};
  let taxStatusMap = new Map();
  let currentTab = 'basic';
  let sortCol = 'name';
  let sortAsc = true;
  let filterText = '';
  let dailyXanMap = new Map();
  let dailyXanTimeMap = new Map();
  let dailyXan7dMap = new Map();
  let forceRefreshNext = false;
  let _talentDraft = null;
  let _simCompanyTypeId = null;
  let _hasBus2110 = false;
  let talentSortCol = 'name';
  let talentSortAsc = true;

  async function _detectEducationStatus(forceApi = false) {
    // 1. Check local cache / IndexedDB first
    try {
      const saved = await DB.get('settings', 'has_bus2110');
      if (saved && saved.value === true) {
        _hasBus2110 = true;
        return;
      }
    } catch (e) {}

    // 2. Check chrome.storage.local
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get('has_bus2110');
        if (res && res.has_bus2110 === true) {
          _hasBus2110 = true;
          // Sync to IndexedDB
          try { await DB.put('settings', { key: 'has_bus2110', value: true }); } catch (e) {}
          return;
        }
      }
    } catch (e) {}

    // 3. Determine if we need to call API
    const today = Utils.todayKey();
    let lastCheck = '';
    try {
      const checkSetting = await DB.get('settings', 'last_bus2110_check');
      if (checkSetting) lastCheck = checkSetting.value;
    } catch (e) {}

    const needsCheck = forceApi || lastCheck !== today;
    if (needsCheck) {
      try {
        const eduData = await TornAPI.getUserEducation();
        const completed = eduData?.education?.complete || [];
        
        // Save check date to avoid repeated calls today
        try { await DB.put('settings', { key: 'last_bus2110_check', value: today }); } catch (e) {}

        if (completed.includes(EDUCATION_IDS.BUS2110)) {
          _hasBus2110 = true;
          // Save to IndexedDB
          try { await DB.put('settings', { key: 'has_bus2110', value: true }); } catch (e) {}
          // Save to chrome.storage.local
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              await chrome.storage.local.set({ has_bus2110: true });
            }
          } catch (e) {}
        }
      } catch (err) {
        console.warn('[EmployeePage] Failed to fetch education status from API:', err.message);
      }
    }
  }

  async function init() {
    await render();
  }

  async function render() {
    const container = document.getElementById('page-content');
    if (!container) return;

    // Header skeleton
    container.innerHTML = `
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <i class="fas fa-users text-torn-accent"></i> 员工管理
        </h1>
        <div class="flex gap-2">
          <button id="emp-export" class="btn btn-secondary btn-sm">
            <i class="fas fa-download"></i> 导出 CSV
          </button>
          <button id="emp-refresh" class="btn btn-primary btn-sm">
            <i class="fas fa-sync-alt"></i> 刷新
          </button>
        </div>
      </div>
      <div id="emp-kpis" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"></div>
      <div id="emp-search" class="mb-4"></div>
      <div id="emp-tabs" class="mb-4"></div>
      <div id="emp-content" class="card"></div>
    `;

    document.getElementById('emp-refresh')?.addEventListener('click', () => {
      forceRefreshNext = true;
      render();
    });
    document.getElementById('emp-export')?.addEventListener('click', () => exportCSV());

    Utils.showLoading('加载员工数据...');
    try {
      await _loadAndRender();
    } catch (err) {
      container.innerHTML = `
        <div class="text-center text-red-400 py-10">
          <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
          <p>加载失败: ${err.message}</p>
          <button onclick="EmployeePage.render()" class="btn btn-primary btn-sm mt-3">重试</button>
        </div>
      `;
    } finally {
      Utils.hideLoading();
    }
  }

  async function _loadAndRender() {
    const isForce = forceRefreshNext;
    if (isForce) {
      forceRefreshNext = false; // Reset early
      AppCache.invalidate('employees');
    }

    // Detect BUS2110 education status (forces API check if isForce is true)
    await _detectEducationStatus(isForce);

    const data = await AppCache.getOrFetch('employees', () => TornAPI.getEmployeesUnified());
    employees = data;

    // Save snapshots to employee_history
    const today = Utils.todayKey();
    for (const emp of employees) {
      const pid = Number(emp.id || emp.player_id);
      await DB.put('employee_history', {
        player_id: pid,
        date: today,
        name: emp.name,
        position: emp.position?.name || '',
        days_in_company: emp.days_in_company,
        effectiveness: emp.effectiveness?.total ?? 0,
        wage: emp.wage ?? 0,
        status: emp.status?.state || '',
        stats: emp.stats || {},
        effectiveness_detail: emp.effectiveness || {}
      });

      // 保存/更新当天在职员工的 merit 历史记录
      if (emp.effectiveness?.merits !== undefined) {
        try {
          const meritsVal = Number(emp.effectiveness.merits) || 0;
          const existing = await DB.getByIndex('merit_history', 'player_id', pid);
          const todayRecord = existing?.find(r => r.date === today);
          if (todayRecord) {
            todayRecord.merit_score = meritsVal;
            await DB.put('merit_history', todayRecord);
          } else {
            await DB.put('merit_history', {
              player_id: pid,
              date: today,
              merit_score: meritsVal
            });
          }
        } catch (e) {
          console.warn('[EmployeePage] Failed to save merit_history for', pid, e);
        }
      }
    }

    // Load notes early (needed when archiving departing employees)
    notes = {};
    const noteRecordsEarly = await DB.getAll('employee_notes');
    noteRecordsEarly.forEach(n => { notes[Number(n.player_id)] = n.note || ''; });

    // Track in employees_master (detect new/leaving)
    // 统一使用 Number 类型的 player_id 防止 key 类型不一致导致重复记录
    const existingMasters = await DB.getAll('employees_master');
    const existingMap = new Map();
    existingMasters.forEach(m => existingMap.set(Number(m.player_id), m));
    const currentIds = new Set(employees.map(e => Number(e.id || e.player_id)));

    for (const emp of employees) {
      const pid = Number(emp.id || emp.player_id);
      if (!pid) continue;
      const existing = existingMap.get(pid);
      if (!existing) {
        await DB.put('employees_master', {
          player_id: pid,
          name: emp.name,
          position: emp.position?.name || '',
          first_seen: today,
          last_seen: today,
          left_date: null
        });
      } else {
        // 如果 existing 的 player_id 是字符串类型，修正为 Number
        existing.player_id = pid;
        existing.last_seen = today;
        existing.name = emp.name;
        existing.position = emp.position?.name || '';
        await DB.put('employees_master', existing);
      }
    }

    // Mark leaving employees — snapshot archive for history tab
    for (const m of existingMasters) {
      const pid = Number(m.player_id);
      if (!currentIds.has(pid) && !m.left_date) {
        const emp = employees.find(e => Number(e.id || e.player_id) === pid);
        const histRows = (await DB.getByIndex('employee_history', 'player_id', pid)) || [];
        histRows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        const latest = histRows[0] || {};
        const stats = emp?.stats || latest.stats || latest.effectiveness_detail || {};
        m.left_date = today;
        m.archive = {
          position: Utils.formatPosition(emp?.position || m.position),
          days_in_company: emp?.days_in_company ?? latest.days_in_company ?? m.days_in_company ?? 0,
          effectiveness: emp?.effectiveness?.total ?? latest.effectiveness ?? latest.effectiveness_detail?.total ?? null,
          wage: emp?.wage ?? latest.wage ?? 0,
          stats: {
            manual_labor: stats.manual_labor ?? emp?.manual_labor ?? 0,
            intelligence: stats.intelligence ?? emp?.intelligence ?? 0,
            endurance: stats.endurance ?? emp?.endurance ?? 0
          },
          merits: emp?.effectiveness?.merits ?? latest.effectiveness_detail?.merits ?? null,
          note: notes[pid] || notes[emp?.id] || m.archive?.note || ''
        };
        await DB.put('employees_master', m);
      }
    }

    // notes already loaded above

    taxStatusMap = await Utils.getEmployeeTaxStatusMap(Utils.weekKey());

    dailyXanMap = new Map();
    dailyXanTimeMap = new Map();
    try {
      const rehabCfgs = await DB.getAll('rehab_config') || [];
      rehabCfgs.forEach((c) => {
        if (c.daily_xan != null && !Number.isNaN(Number(c.daily_xan))) {
          dailyXanMap.set(Number(c.player_id), Number(c.daily_xan));
          dailyXanTimeMap.set(Number(c.player_id), Number(c.updated_at || 0));
        }
      });
    } catch (e) { /* optional */ }

    if (isForce) {
      Utils.showLoading('正在更新近7日日均 Xanax 数据 (API)...');
      try {
        await _refreshDailyXan7d(employees);
      } catch (err) {
        console.error('[EmployeePage] Failed to refresh 7-day daily xan:', err);
      }
    }

    dailyXan7dMap = new Map();
    try {
      const snapshots = await DB.getAll('rehab_api_snapshots') || [];
      const snapshotsByPlayer = new Map();
      snapshots.forEach(s => {
        const pid = Number(s.player_id);
        if (!pid) return;
        if (!snapshotsByPlayer.has(pid)) {
          snapshotsByPlayer.set(pid, []);
        }
        snapshotsByPlayer.get(pid).push(s);
      });

      snapshotsByPlayer.forEach((playerSnaps, pid) => {
        const validSnaps = playerSnaps.filter(s => s && s.date && s.xantaken != null && !isNaN(Number(s.xantaken)));
        if (validSnaps.length < 2) return;

        validSnaps.sort((a, b) => b.date.localeCompare(a.date));

        const latest = validSnaps[0];
        const oldest = validSnaps[validSnaps.length - 1];

        const getDaysDiff = (d1, d2) => {
          return Math.round(Math.abs(new Date(d1) - new Date(d2)) / (24 * 60 * 60 * 1000));
        };

        const totalSpan = getDaysDiff(latest.date, oldest.date);
        if (totalSpan < 7) return;

        let targetSnap = null;
        let minDiff = Infinity;
        let targetDays = 0;

        for (let i = 1; i < validSnaps.length; i++) {
          const s = validSnaps[i];
          const days = getDaysDiff(latest.date, s.date);
          const diff = Math.abs(days - 7);
          if (diff < minDiff) {
            minDiff = diff;
            targetSnap = s;
            targetDays = days;
          }
        }

        if (targetSnap && targetDays > 0) {
          const diffXan = latest.xantaken - targetSnap.xantaken;
          const avg = diffXan / targetDays;
          dailyXan7dMap.set(pid, Math.max(0, avg));
        }
      });
    } catch (e) {
      console.warn('[EmployeePage] Failed to calculate 7-day average Xanax:', e.message);
    }

    // Render KPIs
    _renderKPIs();

    // Render search
    const searchEl = document.getElementById('emp-search');
    searchEl.innerHTML = UI.searchBar('搜索员工姓名...', 'emp-search-input');
    const searchInput = document.getElementById('emp-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', Utils.debounce(() => {
        filterText = searchInput.value.trim().toLowerCase();
        _renderContent();
      }, 200));
    }

    // Render tabs + content
    _renderTabs();

    _renderContent();
  }

  function _renderKPIs() {
    const kpiEl = document.getElementById('emp-kpis');
    if (!kpiEl) return;

    const total = employees.length;
    const avgEff = total > 0
      ? Math.round(employees.reduce((s, e) => s + (e.effectiveness?.total ?? 0), 0) / total)
      : 0;

    const nowSec = Math.floor(Date.now() / 1000);
    const onlineCount = employees.filter(e => {
      const ts = e.last_action?.timestamp || 0;
      return ts > 0 && (nowSec - ts) < 300; // 5 min
    }).length;

    const inactiveCount = employees.filter(e => {
      const ts = e.last_action?.timestamp || 0;
      return ts > 0 && (nowSec - ts) > 86400; // 24h
    }).length;

    kpiEl.innerHTML =
      UI.kpiCard('fas fa-users', '总人数', total, '在职员工', 'accent') +
      UI.kpiCard('fas fa-chart-line', '平均效能', avgEff + '%', '全体平均', 'gold') +
      UI.kpiCard('fas fa-circle', '在线人数', onlineCount, '5分钟内活跃', 'green') +
      UI.kpiCard('fas fa-moon', '不活跃', inactiveCount, '超过24小时未活跃', 'red');
  }

  function _renderTabs() {
    const tabsEl = document.getElementById('emp-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = UI.tabNav([
      { id: 'basic', label: '基本信息', icon: 'fas fa-id-card' },
      { id: 'effectiveness', label: '效能详情', icon: 'fas fa-chart-bar' },
      { id: 'stats', label: '属性值', icon: 'fas fa-dumbbell' },
      { id: 'notes', label: '备注', icon: 'fas fa-sticky-note' },
      { id: 'history', label: '人才库', icon: 'fas fa-history' }
    ], currentTab, 'emp-tab-nav');

    // Bind tab clicks
    tabsEl.querySelectorAll('.tab-item').forEach(item => {
      item.addEventListener('click', () => {
        currentTab = item.dataset.tab;
        _renderTabs();
        _renderContent();
      });
    });
  }

  function _getFilteredSorted() {
    let list = [...employees];
    if (filterText) {
      list = list.filter(e => (e.name || '').toLowerCase().includes(filterText));
    }
    if (sortCol) {
      list.sort((a, b) => {
        let va = _sortVal(a, sortCol);
        let vb = _sortVal(b, sortCol);
        if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
    }
    return list;
  }

  function _sortVal(emp, col) {
    const map = {
      name: emp.name || '',
      position: emp.position?.name || '',
      days: emp.days_in_company ?? 0,
      wage: emp.wage ?? 0,
      status: emp.status?.state || '',
      addiction: Utils.getEmployeeAddiction(emp) ?? -999,
      daily_xan: dailyXanMap.get(Number(emp.id)) ?? -1,
      daily_xan_7d: dailyXan7dMap.get(Number(emp.id)) ?? -1,
      last_action: emp.last_action?.timestamp || 0,
      effectiveness: (emp.effectiveness?.total ?? emp.working_stats?.total ?? -1),
      tax_paid: { paid: 4, partial: 3, unpaid: 2, writeoff: 1 }[taxStatusMap.get(Number(emp.id))?.status] || 0,
      note: notes[emp.id] || '',
      working_stats: emp.effectiveness?.working_stats ?? 0,
      settled_in: emp.effectiveness?.settled_in ?? 0,
      book: emp.effectiveness?.book ?? 0,
      merits: emp.effectiveness?.merits ?? 0,
      director_education: emp.effectiveness?.director_education ?? 0,
      management: emp.effectiveness?.management ?? 0,
      wrong_gender: emp.effectiveness?.wrong_gender ?? 0,
      eff_addiction: emp.effectiveness?.addiction ?? 0,
      inactivity: emp.effectiveness?.inactivity ?? 0,
      total: emp.effectiveness?.total ?? 0,
      manual_labor: emp.stats?.manual_labor ?? 0,
      intelligence: emp.stats?.intelligence ?? 0,
      endurance: emp.stats?.endurance ?? 0,
      merits: emp.effectiveness?.merits ?? 0,
    };
    return map[col] ?? '';
  }

  function _sortHeader(label, col) {
    const arrow = sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : '';
    const cls = 'cursor-pointer hover:text-white select-none';
    return `<span class="${cls}" data-sort-col="${col}">${label}${arrow}</span>`;
  }

  function _bindSortHeaders() {
    const content = document.getElementById('emp-content');
    if (!content) return;
    content.querySelectorAll('[data-sort-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sortCol;
        if (sortCol === col) { sortAsc = !sortAsc; }
        else { sortCol = col; sortAsc = true; }
        _renderContent();
      });
    });
  }

  function _renderContent() {
    const contentEl = document.getElementById('emp-content');
    if (!contentEl) return;

    if (currentTab === 'history') {
      _renderHistoryTab(contentEl);
      return;
    }

    const list = _getFilteredSorted();
    if (list.length === 0) {
      contentEl.innerHTML = UI.emptyState('fas fa-user-slash', '未找到员工');
      return;
    }

    switch (currentTab) {
      case 'basic': _renderBasic(contentEl, list); break;
      case 'effectiveness': _renderEffectiveness(contentEl, list); break;
      case 'stats': _renderStats(contentEl, list); break;
      case 'notes': _renderNotes(contentEl, list); break;
    }

    _bindSortHeaders();
    if (currentTab === 'basic') _enrichDailyXan(list);
  }

  async function _enrichDailyXan(list, isForce = false) {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const need = list.filter((emp) => {
      const pid = Number(emp.id || emp.player_id);
      if (!pid) return false;
      if (isForce) return true; // Force refresh bypasses cache check
      const cached = dailyXanMap.get(pid);
      const lastUpdate = dailyXanTimeMap.get(pid) || 0;
      return cached == null || cached > 10 || (Date.now() - lastUpdate > ONE_DAY);
    });
    if (!need.length) return;

    const sliceLimit = isForce ? need.length : 8;
    for (const emp of need.slice(0, sliceLimit)) {
      const pid = Number(emp.id || emp.player_id);
      try {
        const ps = await TornAPI.getPlayerPersonalStats(pid);
        const daily = Utils.dailyXanFromPersonalStats(ps);
        if (daily != null) {
          dailyXanMap.set(pid, daily);
          dailyXanTimeMap.set(pid, Date.now());
          await DB.put('rehab_config', {
            player_id: pid,
            daily_xan: daily,
            updated_at: Date.now()
          });
        } else {
          dailyXanMap.set(pid, 0);
          dailyXanTimeMap.set(pid, Date.now());
        }
      } catch (e) {
        dailyXanMap.set(pid, 0);
        dailyXanTimeMap.set(pid, Date.now());
      }
    }
    if (!isForce && currentTab === 'basic') _renderContent();
  }

  async function _refreshDailyXan7d(list) {
    const todayStr = Utils.todayKey();
    const db = DB.db;
    if (!db) return;

    for (const emp of list) {
      const pid = Number(emp.id || emp.player_id);
      if (!pid) continue;

      try {
        const ps = await TornAPI.getPlayerRehabBackupStats(pid);
        
        // Read existing snapshots for the player (both Number and String types for backward compatibility)
        const readTx = db.transaction('rehab_api_snapshots', 'readonly');
        const index = readTx.objectStore('rehab_api_snapshots').index('player_id');
        
        const playerSnaps = await new Promise((resolve) => {
          const reqNum = index.getAll(pid);
          reqNum.onsuccess = () => {
            const numResult = reqNum.result || [];
            const reqStr = index.getAll(String(pid));
            reqStr.onsuccess = () => {
              const strResult = reqStr.result || [];
              const combined = [...numResult];
              for (const r of strResult) {
                if (!combined.some(c => c.id === r.id)) combined.push(r);
              }
              resolve(combined);
            };
            reqStr.onerror = () => resolve(numResult);
          };
          reqNum.onerror = () => {
            const reqStr = index.getAll(String(pid));
            reqStr.onsuccess = () => resolve(reqStr.result || []);
            reqStr.onerror = () => resolve([]);
          };
        });

        const existingToday = playerSnaps.find(r => r.date === todayStr);

        if (existingToday) {
          existingToday.switravel = ps.switravel;
          existingToday.rehabs = ps.rehabs;
          existingToday.xantaken = ps.xantaken;
          existingToday.timestamp = Date.now();

          const writeTx = db.transaction('rehab_api_snapshots', 'readwrite');
          writeTx.objectStore('rehab_api_snapshots').put(existingToday);
          await new Promise(resolve => { writeTx.oncomplete = resolve; writeTx.onerror = resolve; });
        } else {
          const writeTx = db.transaction('rehab_api_snapshots', 'readwrite');
          writeTx.objectStore('rehab_api_snapshots').put({
            player_id: pid,
            date: todayStr,
            switravel: ps.switravel,
            rehabs: ps.rehabs,
            xantaken: ps.xantaken,
            timestamp: Date.now()
          });
          await new Promise(resolve => { writeTx.oncomplete = resolve; writeTx.onerror = resolve; });
        }
      } catch (err) {
        console.warn(`[EmployeePage] Failed to refresh daily xan 7d for ${emp.name || pid}:`, err.message);
      }
    }
  }

  function _empProfileLink(emp) {
    return `<a href="https://www.torn.com/profiles.php?XID=${emp.id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`;
  }

  // Tab 1 - 基本信息
  function _renderBasic(container, list) {
    const rows = list.map(emp => {
      const statusState = emp.status?.state || 'Okay';
      const dailyXan = dailyXanMap.get(Number(emp.id));
      const dailyXan7d = dailyXan7dMap.get(Number(emp.id));
      const lastTs = emp.last_action?.timestamp || 0;
      const effVal = emp.effectiveness?.total ?? emp.working_stats?.total ?? 'N/A';
      const taxPaid = Utils.formatEmployeeTaxStatus(taxStatusMap.get(Number(emp.id)));
      const note = notes[emp.id] || '—';
      return {
        name: _empProfileLink(emp),
        position: emp.position?.name || '-',
        days: emp.days_in_company ?? 0,
        wage: Utils.formatMoney(emp.wage ?? 0),
        status: `<span class="badge ${Utils.statusDotClass(statusState)}">${statusState}</span>`,
        addiction: Utils.formatAddictionCell(emp),
        daily_xan: dailyXan != null && dailyXan >= 0
          ? `<span class="font-mono text-gray-200">${dailyXan.toFixed(2)}</span>`
          : '<span class="text-gray-500 text-xs">加载中</span>',
        daily_xan_7d: dailyXan7d != null && dailyXan7d >= 0
          ? `<span class="font-mono text-gray-200">${dailyXan7d.toFixed(2)}</span>`
          : '<span class="text-gray-500">—</span>',
        last_action: Utils.relativeTime(lastTs),
        effectiveness: typeof effVal === 'number'
          ? `<span class="font-mono" style="color: ${Utils.effColor(effVal)}">${effVal}</span>`
          : `<span class="text-gray-400 font-mono">${effVal}</span>`,
        tax_paid: taxPaid,
        note: `<span class="text-gray-400">${Utils.escapeHtml ? Utils.escapeHtml(note) : note}</span>`,
        id: emp.id
      };
    });

    container.innerHTML = UI.dataTable({
      id: 'emp-basic-table',
      sortable: false,
      emptyText: '无员工数据',
      headers: [
        { key: 'name', label: _sortHeader('姓名', 'name') },
        { key: 'position', label: _sortHeader('职位', 'position') },
        { key: 'days', label: _sortHeader('天数', 'days') },
        { key: 'wage', label: _sortHeader('工资', 'wage') },
        { key: 'status', label: _sortHeader('状态', 'status') },
        { key: 'addiction', label: _sortHeader('毒瘾', 'eff_addiction') },
        { key: 'daily_xan', label: _sortHeader('日均Xan', 'daily_xan') },
        { key: 'daily_xan_7d', label: _sortHeader('近7日日均Xan', 'daily_xan_7d') },
        { key: 'last_action', label: _sortHeader('最后活跃', 'last_action') },
        { key: 'effectiveness', label: _sortHeader('效能', 'effectiveness') },
        { key: 'tax_paid', label: _sortHeader('本周缴税', 'tax_paid') },
        { key: 'note', label: _sortHeader('备注', 'note') },
      ],
      rows
    });
  }

  // Tab 2 - 效能详情
  function _renderEffectiveness(container, list) {
    const effFields = [
      { key: 'working_stats', label: 'Working Stats' },
      { key: 'settled_in', label: 'Settled In' },
      { key: 'book', label: 'Book' },
      { key: 'merits', label: 'Merits' },
      { key: 'director_education', label: 'Director Edu' },
      { key: 'management', label: 'Management' },
      { key: 'wrong_gender', label: 'Wrong Gender' },
      { key: 'addiction', label: 'Addiction' },
      { key: 'inactivity', label: 'Inactivity' },
      { key: 'total', label: 'Total' },
    ];

    const getFieldColor = (key, val) => {
      if (key === 'total' || key === 'working_stats') {
        return Utils.effColor(val);
      }
      if (key === 'merits') {
        if (val === 10) return '#f5a623'; // Gold for 10 (max)
        return val > 0 ? '#4ade80' : '#888888';
      }
      if (key === 'director_education') {
        if (val >= 10) return '#4ade80'; // Green for 10-12
        if (val >= 8) return '#f97316'; // Orange for 8-10
        return val > 0 ? '#facc15' : '#888888'; // Yellow for 0-8, Gray for 0
      }
      if (key === 'settled_in') {
        return val === 0 ? '#888888' : Utils.effColor(val, 10);
      }
      // Other positive bonus fields
      if (['book', 'management'].includes(key)) {
        return val > 0 ? '#4ade80' : '#888888';
      }
      // Negative penalty fields
      if (['wrong_gender', 'addiction', 'inactivity'].includes(key)) {
        return val < 0 ? '#ef4444' : '#888888';
      }
      return '#888888';
    };

    const rows = list.map(emp => {
      const eff = emp.effectiveness || {};
      const row = { name: _empProfileLink(emp), id: emp.id };
      effFields.forEach(f => {
        const val = eff[f.key] ?? 0;
        if (f.key === 'total') {
          row[f.key] = UI.statBar('', val, 100, getFieldColor(f.key, val), true);
        } else {
          row[f.key] = `<span class="font-mono" style="color: ${getFieldColor(f.key, val)}">${val}</span>`;
        }
      });
      return row;
    });

    const headers = [
      { key: 'name', label: _sortHeader('姓名', 'name') },
      ...effFields.map(f => ({
        key: f.key,
        label: _sortHeader(f.label, f.key === 'addiction' ? 'eff_addiction' : f.key)
      }))
    ];

    container.innerHTML = UI.dataTable({
      id: 'emp-eff-table',
      sortable: false,
      emptyText: '无效能数据',
      headers,
      rows
    });
  }

  // Tab 3 - 属性值
  function _renderStats(container, list) {
    let totalML = 0, totalInt = 0, totalEnd = 0;

    const rows = list.map(emp => {
      const stats = emp.stats || {};
      const ml = stats.manual_labor ?? 0;
      const intel = stats.intelligence ?? 0;
      const end = stats.endurance ?? 0;
      totalML += ml; totalInt += intel; totalEnd += end;
      const merit = emp.effectiveness?.merits ?? 0;
      return {
        name: _empProfileLink(emp),
        manual_labor: `<span class="font-mono">${Utils.formatStatNum(ml)}</span>`,
        intelligence: `<span class="font-mono">${Utils.formatStatNum(intel)}</span>`,
        endurance: `<span class="font-mono">${Utils.formatStatNum(end)}</span>`,
        merits: `<span class="font-mono" style="color: ${merit === 10 ? '#f5a623' : (merit > 0 ? '#4ade80' : '#888888')}">${merit}</span>`,
        id: emp.id
      };
    });

    // Totals row
    rows.push({
      name: '<strong class="text-white">合计</strong>',
      manual_labor: `<strong class="text-torn-gold font-mono">${Utils.formatStatNum(totalML)}</strong>`,
      intelligence: `<strong class="text-torn-gold font-mono">${Utils.formatStatNum(totalInt)}</strong>`,
      endurance: `<strong class="text-torn-gold font-mono">${Utils.formatStatNum(totalEnd)}</strong>`,
      merits: '',
      id: 'totals'
    });

    container.innerHTML = UI.dataTable({
      id: 'emp-stats-table',
      sortable: false,
      emptyText: '无属性数据',
      headers: [
        { key: 'name', label: _sortHeader('姓名', 'name') },
        { key: 'manual_labor', label: _sortHeader('Manual Labor', 'manual_labor') },
        { key: 'intelligence', label: _sortHeader('Intelligence', 'intelligence') },
        { key: 'endurance', label: _sortHeader('Endurance', 'endurance') },
        { key: 'merits', label: _sortHeader('Merit', 'merits') },
      ],
      rows
    });
  }

  // Tab 4 - 备注
  function _renderNotes(container, list) {
    const rows = list.map(emp => {
      const note = notes[emp.id] || '';
      return {
        name: _empProfileLink(emp),
        position: emp.position?.name || '-',
        note: `<textarea class="input emp-note-textarea" data-player-id="${emp.id}" rows="2" placeholder="点击输入备注...">${note}</textarea>`,
        id: emp.id
      };
    });

    container.innerHTML = UI.dataTable({
      id: 'emp-notes-table',
      sortable: false,
      emptyText: '无员工数据',
      headers: [
        { key: 'name', label: '姓名' },
        { key: 'position', label: '职位' },
        { key: 'note', label: '备注', width: '40%' },
      ],
      rows
    });

    // Bind note textareas
    container.querySelectorAll('.emp-note-textarea').forEach(ta => {
      ta.addEventListener('blur', async () => {
        const playerId = parseInt(ta.dataset.playerId);
        const val = ta.value.trim();
        if (val) {
          await DB.put('employee_notes', { player_id: playerId, note: val });
          notes[playerId] = val;
        } else {
          await DB.delete('employee_notes', playerId);
          delete notes[playerId];
        }
        Utils.toast('备注已保存', 'success');
      });
    });
  }

  function _getFormerArchive(emp, allHistory) {
    const pid = Number(emp.player_id);
    const arch = emp.archive || {};
    const playerHistory = allHistory
      .filter(h => Number(h.player_id) === pid)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const latest = playerHistory[0] || {};
    const stats = arch.stats || latest.stats || latest.effectiveness_detail || {};
    return {
      pid,
      position: arch.position || Utils.formatPosition(emp.position) || latest.position || '-',
      days: arch.days_in_company ?? latest.days_in_company ?? '-',
      effectiveness: arch.effectiveness ?? latest.effectiveness ?? 'N/A',
      wage: arch.wage ?? latest.wage ?? 0,
      manual_labor: stats.manual_labor ?? 0,
      intelligence: stats.intelligence ?? 0,
      endurance: stats.endurance ?? 0,
      merits: arch.merits ?? latest.effectiveness_detail?.merits ?? 'N/A',
      note: arch.note || notes[pid] || '',
      total_stats: arch.total_stats ?? null
    };
  }

  async function _enrichFormerTotalStats(leftEmployees, containerEl, allHistory) {
    for (const emp of leftEmployees) {
      if (currentTab !== 'history') break;

      const pid = Number(emp.player_id);
      const cell = containerEl.querySelector(`[data-total-stats-pid="${pid}"]`);
      if (!cell || cell.dataset.loaded === '1') continue;

      const a = _getFormerArchive(emp, allHistory);
      const oldTotal = (a.manual_labor || 0) + (a.intelligence || 0) + (a.endurance || 0);

      try {
        const total = await TornAPI.getPlayerTotalStats(pid);
        if (currentTab !== 'history') break;

        if (total != null) {
          const arch = emp.archive || {};
          arch.total_stats = total;
          arch.total_stats_source = 'hof_workstats';
          emp.archive = arch;
          await DB.put('employees_master', emp);
          
          let display = Utils.formatStatNum(total);
          if (oldTotal > 0) {
            const diff = total - oldTotal;
            const sign = diff > 0 ? '+' : '';
            const colorClass = diff > 0 ? 'text-green-400' : (diff < 0 ? 'text-red-400' : 'text-gray-400');
            display += ` <span class="${colorClass} text-xs">(${sign}${Utils.formatStatNum(diff)})</span>`;
          }
          cell.innerHTML = display;
        } else if ((emp.archive || {}).total_stats == null) {
          cell.innerHTML = 'N/A';
        }
      } catch (e) {
        if ((emp.archive || {}).total_stats == null) {
          cell.innerHTML = 'N/A';
        }
      }
      if (cell) cell.dataset.loaded = '1';
    }
  }

  function _showFormerEmployeeModal(emp, allHistory, containerEl) {
    const a = _getFormerArchive(emp, allHistory);
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    Utils.showModal(`
      <div class="p-6">
        <h3 class="text-lg font-bold text-white mb-4">编辑历史员工 — ${esc(emp.name || a.pid)}</h3>
        <div class="space-y-3 text-sm">
          <div><label class="text-gray-400 block mb-1">职位</label><input class="input" id="former-position" value="${esc(a.position)}" /></div>
          <div><label class="text-gray-400 block mb-1">在职天数</label><input class="input" type="number" id="former-days" value="${a.days === '-' ? '' : a.days}" /></div>
          <div class="grid grid-cols-2 gap-2">
            <div><label class="text-gray-400 block mb-1">效能</label><input class="input" type="number" id="former-eff" value="${a.effectiveness === 'N/A' ? '' : a.effectiveness}" /></div>
            <div><label class="text-gray-400 block mb-1">Merit</label><input class="input" type="number" id="former-merits" value="${a.merits === 'N/A' ? '' : a.merits}" /></div>
          </div>
          <div><label class="text-gray-400 block mb-1">工资 ($)</label><input class="input" type="text" id="former-wage" value="${a.wage}" /></div>
          <div class="grid grid-cols-3 gap-2">
            <div><label class="text-gray-400 block mb-1">Manual Labor</label><input class="input" type="number" id="former-ml" value="${a.manual_labor}" /></div>
            <div><label class="text-gray-400 block mb-1">Intelligence</label><input class="input" type="number" id="former-int" value="${a.intelligence}" /></div>
            <div><label class="text-gray-400 block mb-1">Endurance</label><input class="input" type="number" id="former-end" value="${a.endurance}" /></div>
          </div>
          <div><label class="text-gray-400 block mb-1">备注</label><textarea class="input" id="former-note" rows="3">${esc(a.note)}</textarea></div>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button class="btn btn-secondary" id="former-cancel">取消</button>
          <button class="btn btn-primary" id="former-save">保存</button>
        </div>
      </div>
    `);

    document.getElementById('former-cancel')?.addEventListener('click', () => Utils.hideModal());
    document.getElementById('former-save')?.addEventListener('click', async () => {
      const master = await DB.get('employees_master', a.pid) || { ...emp };
      master.player_id = a.pid;
      master.archive = {
        position: document.getElementById('former-position')?.value.trim() || '-',
        days_in_company: parseInt(document.getElementById('former-days')?.value, 10) || 0,
        effectiveness: parseInt(document.getElementById('former-eff')?.value, 10) || 0,
        merits: parseInt(document.getElementById('former-merits')?.value, 10) || 0,
        wage: Utils.parseMoneyInput(document.getElementById('former-wage')?.value),
        stats: {
          manual_labor: parseInt(document.getElementById('former-ml')?.value, 10) || 0,
          intelligence: parseInt(document.getElementById('former-int')?.value, 10) || 0,
          endurance: parseInt(document.getElementById('former-end')?.value, 10) || 0
        },
        note: document.getElementById('former-note')?.value.trim() || ''
      };
      await DB.put('employees_master', master);
      const noteVal = master.archive.note;
      if (noteVal) {
        await DB.put('employee_notes', { player_id: a.pid, note: noteVal });
        notes[a.pid] = noteVal;
      } else {
        try { await DB.delete('employee_notes', a.pid); } catch (e) { /* */ }
        delete notes[a.pid];
      }
      Utils.toast('历史员工档案已保存', 'success');
      Utils.hideModal();
      if (containerEl) _renderHistoryTab(containerEl);
    });
  }

  async function _getOrDetectCompanyType() {
    let typeId = null;
    try {
      // 1. 优先获取当前真实在职公司的类型
      const cached = AppCache.get('companyData');
      if (cached && cached.profile?.company_type != null) {
        typeId = parseInt(cached.profile.company_type, 10);
      }

      // 2. 如果缓存中没有，通过 API 实时查询公司档案获取当前真实公司类型
      if (!typeId) {
        const profile = await TornAPI.getCompanyProfile();
        const profileType = profile?.company?.company_type ?? profile?.company_type;
        if (profileType != null) {
          typeId = parseInt(profileType, 10);
        }
      }

      // 3. 回退：如果上面都没获取到，则读取训练规划所保存的公司试算设置
      if (!typeId) {
        const saved = await DB.get('settings', 'training_planner_company_type');
        if (saved && saved.value) {
          typeId = parseInt(saved.value, 10);
        }
      }
    } catch (err) {
      console.warn('[EmployeesPage] Failed to detect company type:', err);
    }
    
    // 4. 最低限度兜底：回到默认的第 1 个公司类型
    if (!typeId || !COMPANY_JOBS[typeId]) {
      const firstKey = Object.keys(COMPANY_JOBS)[0];
      typeId = parseInt(firstKey, 10);
    }
    return typeId;
  }

  function _getDirectEdu() {
    let directEdu = 0;
    if (employees && employees.length > 0) {
      const activeEmp = employees.find(e => e.effectiveness?.director_education !== undefined);
      if (activeEmp) {
        directEdu = activeEmp.effectiveness.director_education ?? 0;
      }
    }
    return directEdu;
  }

  function _calculateJobTotalEfficiency(talent, job, directEdu) {
    const stats = {
      MAN: talent.manual_labor || 0,
      INT: talent.intelligence || 0,
      END: talent.endurance || 0
    };
    const pStat = stats[job.primary_req_stat] || 0;
    const pReq = job.primary_req_value || 0;
    const sStat = stats[job.secondary_req_stat] || 0;
    const sReq = job.secondary_req_value || 0;

    let baseEff = 0;
    try {
      const pBase = pReq > 0 ? Math.min(45, (pStat / pReq) * 45) : 0;
      const sBase = sReq > 0 ? Math.min(45, (sStat / sReq) * 45) : 0;
      const mult = _hasBus2110 ? BUS2110_EFFICIENCY_MULTIPLIER : 1.0;
      const pBonus = (pStat > pReq && pReq > 0) ? Math.floor(5 * Math.log2((pStat / pReq) * mult)) : 0;
      const sBonus = (sStat > sReq && sReq > 0) ? Math.floor(5 * Math.log2((sStat / sReq) * mult)) : 0;
      baseEff = pBase + sBase + pBonus + sBonus;
    } catch (e) {
      baseEff = 0;
    }

    const settledIn = talent.settled_in ?? 10;
    const merits = talent.merits ?? 0;
    const addiction = talent.addiction ?? 0;

    return Math.round(baseEff + settledIn + merits + directEdu + addiction);
  }

  function _talentSortHeader(label, col) {
    const arrow = talentSortCol === col ? (talentSortAsc ? ' ▲' : ' ▼') : '';
    const cls = 'cursor-pointer hover:text-white select-none';
    return `<span class="${cls}" data-talent-sort-col="${col}">${label}${arrow}</span>`;
  }

  function _talentSortVal(t, col) {
    if (col === 'name') return t.name || '';
    if (col === 'settle_in') return t.settled_in ?? 10;
    if (col === 'merit') return t.merits ?? 0;
    if (col === 'director_edu') return t.director_education ?? _getDirectEdu();
    if (col === 'addiction') return t.addiction ?? 0;
    if (col === 'stats') {
      return (t.manual_labor || 0) + (t.intelligence || 0) + (t.endurance || 0);
    }
    if (col === 'note') return t.note || '';
    if (col.startsWith('job_')) {
      const jobName = col.replace('job_', '');
      const currentCompany = COMPANY_JOBS[_simCompanyTypeId];
      const job = currentCompany?.jobs.find(j => j.name === jobName);
      if (!job) return 0;
      const tEdu = t.director_education ?? _getDirectEdu();
      return _calculateJobTotalEfficiency(t, job, tEdu);
    }
    return '';
  }

  function _showTalentModal(talent, parentContainer) {
    const directEdu = _getDirectEdu();
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    // Helper inside modal to parse candidate details (ID, name, stats, merits) from pasted text
    function _parseSmartText(text) {
      const result = {};
      if (!text) return result;

      // 1. Try to find player ID and Name
      const urlPattern = /(?:https?:\/\/)?(?:www\.)?torn\.com\/profiles\.php\?[XN]ID=(\d+)/gi;
      let match = urlPattern.exec(text);
      if (match && match[1]) {
        result.player_id = parseInt(match[1], 10);
      } else {
        const bracketPattern = /(\w[\w\s.-]+)\s*\[(\d+)\]/i;
        const bracketMatch = bracketPattern.exec(text);
        if (bracketMatch) {
          result.name = bracketMatch[1].trim();
          result.player_id = parseInt(bracketMatch[2], 10);
        } else {
          const idMatch = /(?:id|uid|玩家ID|ID)[:\s]+(\d+)/i.exec(text);
          if (idMatch && idMatch[1]) {
            result.player_id = parseInt(idMatch[1], 10);
          }
        }
      }

      const parseValue = (valStr) => {
        if (!valStr) return 0;
        valStr = valStr.trim().toLowerCase();
        // handle k and m suffixes
        if (valStr.endsWith('k')) return Math.round(parseFloat(valStr) * 1000);
        if (valStr.endsWith('m')) return Math.round(parseFloat(valStr) * 1000000);
        return parseInt(valStr.replace(/,/g, ''), 10) || 0;
      };

      // 为了安全提取无标签的顺序数值，克隆一份文本用来剔除已识别的 ID, URL 链接及 Merit
      let cleanText = text;
      if (result.player_id) {
        cleanText = cleanText.replace(new RegExp(String(result.player_id), 'g'), '');
      }
      cleanText = cleanText.replace(/(?:https?:\/\/)?(?:www\.)?torn\.com\/profiles\.php\?[XN]ID=\d+/gi, '');

      // 2. Parse stats (Man, Int, End) using labels first
      const manMatch = /\b(?:manual\s*labor|man)\b[:\s]*([\d,.]+[km]?)/i.exec(cleanText);
      if (manMatch && manMatch[1]) {
        result.manual_labor = parseValue(manMatch[1]);
      }

      const intMatch = /\b(?:intelligence|int)\b[:\s]*([\d,.]+[km]?)/i.exec(cleanText);
      if (intMatch && intMatch[1]) {
        result.intelligence = parseValue(intMatch[1]);
      }

      const endMatch = /\b(?:endurance|end)\b[:\s]*([\d,.]+[km]?)/i.exec(cleanText);
      if (endMatch && endMatch[1]) {
        result.endurance = parseValue(endMatch[1]);
      }

      // Merit
      const meritMatch = /\b(?:merits?|merit)\b[:\s]*([\d,.]+[km]?)/i.exec(cleanText);
      if (meritMatch && meritMatch[1]) {
        result.merits = parseValue(meritMatch[1]);
        if (meritMatch[0]) {
          cleanText = cleanText.replace(meritMatch[0], '');
        }
      }

      // 3. Fallback sequential match: if any of the three stats are missing, try extracting raw numbers in man, int, end order
      if (result.manual_labor === undefined || result.intelligence === undefined || result.endurance === undefined) {
        // Remove label matched stats to avoid duplicate matching
        if (manMatch && manMatch[0]) cleanText = cleanText.replace(manMatch[0], '');
        if (intMatch && intMatch[0]) cleanText = cleanText.replace(intMatch[0], '');
        if (endMatch && endMatch[0]) cleanText = cleanText.replace(endMatch[0], '');

        const numberPattern = /\b\d+(?:[.,]\d+)?[km]?\b/gi;
        const numbersFound = [];
        let numMatch;
        while ((numMatch = numberPattern.exec(cleanText)) !== null) {
          numbersFound.push(numMatch[0]);
        }

        if (numbersFound.length >= 3) {
          if (result.manual_labor === undefined) result.manual_labor = parseValue(numbersFound[0]);
          if (result.intelligence === undefined) result.intelligence = parseValue(numbersFound[1]);
          if (result.endurance === undefined) result.endurance = parseValue(numbersFound[2]);
        }
      }

      return result;
    }

    // 默认或草稿数据读取
    let dSmartParse = '';
    let dPlayerId = '';
    let dName = '';
    let dMl = '';
    let dInt = '';
    let dEnd = '';
    let dMerits = 0;
    let dSettleIn = 10;
    let dDirEdu = directEdu;
    let dAddiction = '';
    let dNote = '';

    if (talent) {
      dPlayerId = talent.player_id ?? '';
      dName = talent.name ?? '';
      dMl = talent.manual_labor ?? '';
      dInt = talent.intelligence ?? '';
      dEnd = talent.endurance ?? '';
      dMerits = talent.merits ?? 0;
      dSettleIn = talent.settled_in ?? 10;
      dDirEdu = talent.director_education ?? directEdu;
      dAddiction = talent.addiction ?? '';
      dNote = talent.note ?? '';
    } else if (_talentDraft) {
      dSmartParse = _talentDraft.smart_parse ?? '';
      dPlayerId = _talentDraft.player_id ?? '';
      dName = _talentDraft.name ?? '';
      dMl = _talentDraft.manual_labor ?? '';
      dInt = _talentDraft.intelligence ?? '';
      dEnd = _talentDraft.endurance ?? '';
      dMerits = _talentDraft.merits ?? 0;
      dSettleIn = _talentDraft.settled_in ?? 10;
      dDirEdu = _talentDraft.director_education ?? directEdu;
      dAddiction = _talentDraft.addiction ?? '';
      dNote = _talentDraft.note ?? '';
    }

    Utils.showModal(`
      <div class="p-6">
        <h3 class="text-lg font-bold text-white mb-4">
          <i class="fas ${talent ? 'fa-edit text-torn-gold' : 'fa-user-plus text-torn-accent'} mr-2"></i>${talent ? '编辑人才' : '添加人才'}
        </h3>
        <div class="space-y-3 text-sm">
          <div>
            <label class="text-gray-400 block mb-1">智能属性解析（可在此直接粘贴玩家链接和三维属性文本，支持简写与 k 后缀）</label>
            <textarea class="input" id="talent-smart-parse" rows="3" placeholder="在此粘贴玩家链接和三维。例如：&#10;https://www.torn.com/profiles.php?XID=123456&#10;Manual labor 6,276&#10;Intelligence 61,217&#10;Endurance 35,657">${esc(dSmartParse)}</textarea>
          </div>
          <div class="border-t border-torn-border my-2"></div>
          <div>
            <label class="text-gray-400 block mb-1">玩家 ID / Profile 链接</label>
            <input class="input" id="talent-id" value="${dPlayerId}" ${talent ? 'disabled' : ''} placeholder="Torn 玩家 ID 或 profile 链接" />
          </div>
          <div>
            <label class="text-gray-400 block mb-1">姓名</label>
            <input class="input" id="talent-name" value="${esc(dName)}" placeholder="手动填写或粘贴链接自动获取" />
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div><label class="text-gray-400 block mb-1">Manual Labor</label><input class="input" type="number" id="talent-ml" value="${dMl}" placeholder="0" /></div>
            <div><label class="text-gray-400 block mb-1">Intelligence</label><input class="input" type="number" id="talent-int" value="${dInt}" placeholder="0" /></div>
            <div><label class="text-gray-400 block mb-1">Endurance</label><input class="input" type="number" id="talent-end" value="${dEnd}" placeholder="0" /></div>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div><label class="text-gray-400 block mb-1">Merit</label><input class="input" type="number" id="talent-merits" value="${dMerits}" /></div>
            <div><label class="text-gray-400 block mb-1">Settle In</label><input class="input" type="number" id="talent-settle-in" value="${dSettleIn}" /></div>
            <div>
              <label class="text-gray-400 block mb-1">Director Edu</label>
              <input class="input" type="number" id="talent-dir-edu" value="${dDirEdu}" />
            </div>
          </div>
          <div>
            <label class="text-gray-400 block mb-1">毒瘾减益 (负数，例: -5，不扣减则留空)</label>
            <input class="input" type="number" id="talent-addiction" value="${dAddiction}" placeholder="留空" />
          </div>
          <div>
            <label class="text-gray-400 block mb-1">备注</label>
            <textarea class="input" id="talent-note" rows="2" placeholder="可选备注">${esc(dNote)}</textarea>
          </div>
        </div>
        <div class="flex justify-end gap-2 mt-6">
          <button class="btn btn-secondary mr-auto" id="talent-clear"><i class="fas fa-eraser"></i> 清空</button>
          <button class="btn btn-secondary" id="talent-cancel">取消</button>
          <button class="btn btn-primary" id="talent-save">保存</button>
        </div>
      </div>
    `);

    const idInput = document.getElementById('talent-id');
    const nameInput = document.getElementById('talent-name');
    const smartTextarea = document.getElementById('talent-smart-parse');

    // 自动保存草稿机制
    const saveDraft = () => {
      if (talent) return; // 编辑模式不产生草稿
      _talentDraft = {
        smart_parse: smartTextarea?.value || '',
        player_id: idInput?.value || '',
        name: nameInput?.value || '',
        manual_labor: document.getElementById('talent-ml')?.value || '',
        intelligence: document.getElementById('talent-int')?.value || '',
        endurance: document.getElementById('talent-end')?.value || '',
        merits: document.getElementById('talent-merits')?.value || '',
        settled_in: document.getElementById('talent-settle-in')?.value || '',
        director_education: document.getElementById('talent-dir-edu')?.value || '',
        addiction: document.getElementById('talent-addiction')?.value || '',
        note: document.getElementById('talent-note')?.value || ''
      };
    };

    // 绑定草稿实时更新监听
    const idsToBind = [
      'talent-smart-parse', 'talent-id', 'talent-name',
      'talent-ml', 'talent-int', 'talent-end',
      'talent-merits', 'talent-settle-in', 'talent-dir-edu',
      'talent-addiction', 'talent-note'
    ];
    idsToBind.forEach(id => {
      document.getElementById(id)?.addEventListener('input', saveDraft);
    });

    // Bind smart parser paste/input
    if (smartTextarea) {
      smartTextarea.addEventListener('input', () => {
        const text = smartTextarea.value;
        const parsed = _parseSmartText(text);

        // 同步回填所有本地已解析出的内容（不等待网络）
        if (parsed.player_id !== undefined && !talent) {
          idInput.value = parsed.player_id;
        }
        if (parsed.name !== undefined && !nameInput.value.trim()) {
          nameInput.value = parsed.name;
        }
        if (parsed.manual_labor !== undefined) {
          document.getElementById('talent-ml').value = parsed.manual_labor;
        }
        if (parsed.intelligence !== undefined) {
          document.getElementById('talent-int').value = parsed.intelligence;
        }
        if (parsed.endurance !== undefined) {
          document.getElementById('talent-end').value = parsed.endurance;
        }
        if (parsed.merits !== undefined) {
          document.getElementById('talent-merits').value = parsed.merits;
        }

        // 回填后触发草稿存盘
        saveDraft();

        // 异步非阻塞反查姓名
        if (parsed.player_id !== undefined && !talent && !nameInput.value.trim()) {
          nameInput.placeholder = '识别姓名中...';
          _resolveName(parsed.player_id).then(resolvedName => {
            if (resolvedName && !nameInput.value.trim()) {
              nameInput.value = resolvedName;
              Utils.toast(`已识别玩家: ${resolvedName}`, 'info');
              saveDraft(); // 姓名更新后再次同步草稿
            }
          }).finally(() => {
            nameInput.placeholder = '手动填写或粘贴链接自动获取';
          });
        }
      });
    }

    // Fallback URL input parser
    if (idInput && !talent) {
      idInput.addEventListener('input', async () => {
        const value = idInput.value.trim();
        if (!value || !value.includes('torn.com/profiles.php')) return;
        const urlPattern = /(?:https?:\/\/)?(?:www\.)?torn\.com\/profiles\.php\?[XN]ID=(\d+)/gi;
        const match = urlPattern.exec(value);
        if (match && match[1]) {
          const pid = parseInt(match[1], 10);
          idInput.value = pid;
          saveDraft();
          
          nameInput.placeholder = '识别姓名中...';
          try {
            const info = await TornAPI.getPlayerInfo(pid);
            if (info && info.name && !nameInput.value.trim()) {
              nameInput.value = info.name;
              Utils.toast(`已识别玩家: ${info.name}`, 'info');
              saveDraft();
            }
          } catch (e) {
            console.warn(e);
          } finally {
            nameInput.placeholder = '手动填写或粘贴链接自动获取';
          }
        }
      });
    }

    async function _resolveName(playerId) {
      try {
        const info = await TornAPI.getPlayerInfo(playerId);
        return info.name || null;
      } catch (e) {
        return null;
      }
    }

    // 清空按钮逻辑
    document.getElementById('talent-clear')?.addEventListener('click', () => {
      if (!talent) {
        _talentDraft = null;
      }
      
      const smartParseInput = document.getElementById('talent-smart-parse');
      if (smartParseInput) smartParseInput.value = '';
      
      const pIdInput = document.getElementById('talent-id');
      if (pIdInput && !talent) pIdInput.value = ''; 
      
      const pNameInput = document.getElementById('talent-name');
      if (pNameInput) pNameInput.value = '';
      
      document.getElementById('talent-ml').value = '';
      document.getElementById('talent-int').value = '';
      document.getElementById('talent-end').value = '';
      document.getElementById('talent-merits').value = '0';
      document.getElementById('talent-settle-in').value = '10';
      document.getElementById('talent-dir-edu').value = directEdu;
      document.getElementById('talent-addiction').value = '';
      document.getElementById('talent-note').value = '';
      
      Utils.toast('已清空表单输入', 'info');
    });

    // 取消
    document.getElementById('talent-cancel')?.addEventListener('click', () => {
      _talentDraft = null; // 取消后清空草稿
      Utils.hideModal();
    });

    // 保存
    document.getElementById('talent-save')?.addEventListener('click', async () => {
      const pidVal = parseInt(document.getElementById('talent-id')?.value, 10);
      const nameVal = document.getElementById('talent-name')?.value.trim();
      const mlVal = parseInt(document.getElementById('talent-ml')?.value, 10) || 0;
      const intVal = parseInt(document.getElementById('talent-int')?.value, 10) || 0;
      const endVal = parseInt(document.getElementById('talent-end')?.value, 10) || 0;
      const meritVal = parseInt(document.getElementById('talent-merits')?.value, 10) || 0;
      const settleVal = parseInt(document.getElementById('talent-settle-in')?.value, 10) || 0;
      const dirVal = parseInt(document.getElementById('talent-dir-edu')?.value, 10) || 0;
      const addValRaw = document.getElementById('talent-addiction')?.value.trim();
      const addVal = addValRaw === '' ? null : -Math.abs(parseInt(addValRaw, 10) || 0);
      const noteVal = document.getElementById('talent-note')?.value.trim() || '';

      if (isNaN(pidVal)) {
        Utils.toast('请输入有效的玩家 ID', 'error');
        return;
      }
      if (!nameVal) {
        Utils.toast('请输入或识别姓名', 'error');
        return;
      }

      await DB.put('talents', {
        player_id: pidVal,
        name: nameVal,
        manual_labor: mlVal,
        intelligence: intVal,
        endurance: endVal,
        merits: meritVal,
        settled_in: settleVal,
        director_education: dirVal,
        addiction: addVal,
        note: noteVal,
        updated_at: Date.now()
      });

      _talentDraft = null; // 保存后清空草稿
      Utils.toast(talent ? '人才信息已更新' : '人才添加成功', 'success');
      Utils.hideModal();
      _renderHistoryTab(parentContainer);
    });
  }

  // Tab 5 - 历史员工与人才库
  async function _renderHistoryTab(container) {
    const mainContent = document.getElementById('main-content') || document.documentElement;
    const scrollTop = mainContent ? mainContent.scrollTop : 0;
    try {
      if (!_simCompanyTypeId) {
        _simCompanyTypeId = await _getOrDetectCompanyType();
      }

      const allHistory = await DB.getAll('employee_history');
      const allMasters = await DB.getAll('employees_master');
      const leftEmployees = allMasters.filter(m => m.left_date !== null && m.left_date !== undefined);
      const directEdu = _getDirectEdu();

      // Render outer cards skeleton
      container.innerHTML = `
        <div class="card p-4 mb-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-base font-bold text-white flex items-center gap-2">
              <i class="fas fa-history text-torn-accent"></i> 历史员工
            </h3>
          </div>
          <div id="history-table-container"></div>
        </div>

        <div class="card p-4">
          <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h3 class="text-base font-bold text-white flex items-center gap-2">
              <i class="fas fa-users-cog text-torn-accent"></i> 人才库
              <i class="fas fa-exclamation-circle text-gray-500 text-xs cursor-help" title="效率计算默认 settle in=10，addiction=0"></i>
            </h3>
            <div class="flex items-center gap-3">
              <div class="flex items-center gap-2">
                <span class="text-gray-400 text-xs">岗位试算公司:</span>
                <select id="talent-sim-company" class="input py-1 px-2 text-xs" style="width: auto; height: auto; min-height: 0; background-color: #1e1e1e; border: 1px solid #333;">
                  ${Object.keys(COMPANY_JOBS).map(id => {
                    const name = COMPANY_JOBS[id].company_name || Utils.COMPANY_TYPE_NAMES[id] || `Type ${id}`;
                    return `<option value="${id}" ${Number(id) === Number(_simCompanyTypeId) ? 'selected' : ''}>${name}</option>`;
                  }).join('')}
                </select>
              </div>
              <button id="add-talent-btn" class="btn btn-primary btn-xs">
                <i class="fas fa-user-plus"></i> 增加人才
              </button>
            </div>
          </div>
          <div id="talents-table-container"></div>
        </div>
      `;

      // 1. Render historical employees table
      const histContainer = document.getElementById('history-table-container');
      if (leftEmployees.length === 0) {
        histContainer.innerHTML = UI.emptyState('fas fa-ghost', '暂无历史员工');
      } else {
        let meritMap = new Map();
        try {
          const allMerits = await DB.getAll('merit_history');
          if (allMerits?.length) {
            const byPlayer = {};
            allMerits.forEach(m => {
              const pid = Number(m.player_id);
              if (!byPlayer[pid] || (m.date && m.date > (byPlayer[pid].date || ''))) {
                byPlayer[pid] = m;
              }
            });
            Object.keys(byPlayer).forEach(pid => meritMap.set(Number(pid), byPlayer[pid].merit_score));
          }
        } catch (e) { /* optional store */ }

        const rows = leftEmployees.map(emp => {
          const a = _getFormerArchive(emp, allHistory);
          const statsDisplay = `${Utils.formatStatNum(a.manual_labor)} / ${Utils.formatStatNum(a.intelligence)} / ${Utils.formatStatNum(a.endurance)}`;
          
          const oldTotal = (a.manual_labor || 0) + (a.intelligence || 0) + (a.endurance || 0);
          let totalStatsDisplay = '…';
          if (a.total_stats != null) {
             let display = Utils.formatStatNum(a.total_stats);
             if (oldTotal > 0) {
               const diff = a.total_stats - oldTotal;
               const sign = diff > 0 ? '+' : '';
               const colorClass = diff > 0 ? 'text-green-400' : (diff < 0 ? 'text-red-400' : 'text-gray-400');
               display += ` <span class="${colorClass} text-xs">(${sign}${Utils.formatStatNum(diff)})</span>`;
             }
             totalStatsDisplay = display;
          }

          const hasData = a.effectiveness !== 'N/A' || a.manual_labor || a.intelligence || a.endurance || a.wage;
          const hint = hasData ? '' : ' <span class="text-xs text-gray-500">(可编辑补全)</span>';

          return {
            name: `<a href="https://www.torn.com/profiles.php?XID=${a.pid}" target="_blank" class="text-torn-accent hover:underline">${emp.name || 'Unknown'}</a>${hint}`,
            position: a.position,
            days: a.days,
            effectiveness: typeof a.effectiveness === 'number'
              ? `<span class="font-mono" style="color: ${Utils.effColor(a.effectiveness)}">${a.effectiveness}</span>`
              : `<span class="text-gray-400 font-mono">${a.effectiveness}</span>`,
            wage: Utils.formatCurrency(a.wage),
            stats: `<span class="text-gray-400 font-mono">${statsDisplay}</span>`,
            total_stats: `<span class="text-gray-400 font-mono" data-total-stats-pid="${a.pid}">${totalStatsDisplay}</span>`,
            merit: `<span class="text-gray-400 font-mono">${
              meritMap.has(a.pid) ? meritMap.get(a.pid) : (typeof a.merits === 'number' || a.merits !== 'N/A' ? a.merits : 'N/A')
            }</span>`,
            note: `<span class="text-gray-400 text-xs">${a.note || '—'}</span>`,
            left_date: emp.left_date || '-',
            actions: `<button class="btn btn-xs btn-secondary emp-edit-former" data-pid="${a.pid}"><i class="fas fa-edit"></i> 编辑</button>`,
            id: a.pid
          };
        });

        histContainer.innerHTML = UI.dataTable({
          id: 'emp-history-table',
          sortable: false,
          emptyText: '暂无历史员工',
          headers: [
            { key: 'name', label: '姓名' },
            { key: 'position', label: '职位' },
            { key: 'days', label: '在职天数' },
            { key: 'effectiveness', label: '效能' },
            { key: 'wage', label: '工资' },
            { key: 'stats', label: 'Working Stats' },
            { key: 'total_stats', label: '总属性值' },
            { key: 'merit', label: 'Merit' },
            { key: 'note', label: '备注' },
            { key: 'left_date', label: '离职日期' },
            { key: 'actions', label: '操作' },
          ],
          rows
        });

        histContainer.querySelectorAll('.emp-edit-former').forEach(btn => {
          btn.addEventListener('click', () => {
            const pid = Number(btn.dataset.pid);
            const emp = leftEmployees.find(m => Number(m.player_id) === pid);
            if (emp) _showFormerEmployeeModal(emp, allHistory, container);
          });
        });

        _enrichFormerTotalStats(leftEmployees, container, allHistory);
      }

      // 2. Render talents table
      const talentsContainer = document.getElementById('talents-table-container');
      const talents = await DB.getAll('talents') || [];
      if (talents.length === 0) {
        talentsContainer.innerHTML = UI.emptyState('fas fa-user-friends', '人才库暂无候选人，点击右上角“增加人才”');
      } else {
        if (talentSortCol) {
          talents.sort((a, b) => {
            let va = _talentSortVal(a, talentSortCol);
            let vb = _talentSortVal(b, talentSortCol);
            if (typeof va === 'string') {
              va = va.toLowerCase();
              vb = vb.toLowerCase();
            }
            if (va < vb) return talentSortAsc ? -1 : 1;
            if (va > vb) return talentSortAsc ? 1 : -1;
            return 0;
          });
        }

        const currentCompany = COMPANY_JOBS[_simCompanyTypeId];
        const jobs = currentCompany ? currentCompany.jobs : [];

        const headers = [
          { key: 'name', label: _talentSortHeader('姓名', 'name'), class: 'text-center' },
          { key: 'merit', label: _talentSortHeader('Merit', 'merit'), class: 'text-center' },
          { key: 'director_edu', label: _talentSortHeader('Director Edu', 'director_edu'), class: 'text-center' },
          { key: 'stats', label: _talentSortHeader('Working Stats', 'stats'), class: 'text-center' }
        ];

        jobs.forEach(j => {
          headers.push({ key: `job_${j.name}`, label: _talentSortHeader(j.name, `job_${j.name}`), class: 'text-center' });
        });

        headers.push({ key: 'note', label: _talentSortHeader('备注', 'note'), class: 'text-center' });
        headers.push({ key: 'actions', label: '操作', class: 'text-center' });

        const talentRows = talents.map(t => {
          const statsDisplay = `${Utils.formatStatNum(t.manual_labor)} / ${Utils.formatStatNum(t.intelligence)} / ${Utils.formatStatNum(t.endurance)}`;
          const tEdu = t.director_education ?? directEdu;

          const row = {
            name: `<a href="https://www.torn.com/profiles.php?XID=${t.player_id}" target="_blank" class="text-torn-accent hover:underline">${t.name || 'Unknown'}</a>`,
            merit: `<span class="font-mono">${t.merits ?? 0}</span>`,
            director_edu: `<span class="font-mono">${tEdu}</span>`,
            stats: `<span class="text-gray-400 font-mono">${statsDisplay}</span>`,
            note: `<span class="text-gray-400 text-xs">${t.note || '—'}</span>`
          };

          jobs.forEach(j => {
            const eff = _calculateJobTotalEfficiency(t, j, tEdu);
            row[`job_${j.name}`] = `<span class="font-mono" style="color: ${Utils.effColor(eff)}">${eff}</span>`;
          });

          row.actions = `
            <div class="flex gap-1">
              <button class="btn btn-xs btn-secondary talent-edit" data-pid="${t.player_id}"><i class="fas fa-edit"></i> 编辑</button>
              <button class="btn btn-xs btn-danger talent-delete" data-pid="${t.player_id}"><i class="fas fa-trash-alt"></i> 删除</button>
            </div>
          `;

          return row;
        });

        talentsContainer.innerHTML = UI.dataTable({
          id: 'emp-talents-table',
          sortable: false,
          emptyText: '人才库暂无候选人',
          headers,
          rows: talentRows
        });

        talentsContainer.querySelectorAll('.talent-edit').forEach(btn => {
          btn.addEventListener('click', () => {
            const pid = Number(btn.dataset.pid);
            const talent = talents.find(t => t.player_id === pid);
            if (talent) _showTalentModal(talent, container);
          });
        });

        talentsContainer.querySelectorAll('.talent-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            const pid = Number(btn.dataset.pid);
            const talent = talents.find(t => t.player_id === pid);
            if (talent && confirm(`确认删除人才 ${talent.name || pid} 吗？`)) {
              await DB.delete('talents', pid);
              Utils.toast('人才已删除', 'success');
              _renderHistoryTab(container);
            }
          });
        });

        // Bind sort click handlers for talents table
        talentsContainer.querySelectorAll('[data-talent-sort-col]').forEach(th => {
          th.addEventListener('click', () => {
            const col = th.dataset.talentSortCol;
            if (talentSortCol === col) {
              talentSortAsc = !talentSortAsc;
            } else {
              talentSortCol = col;
              talentSortAsc = true;
            }
            _renderHistoryTab(container);
          });
        });
      }

      // Bind events
      document.getElementById('talent-sim-company')?.addEventListener('change', (e) => {
        _simCompanyTypeId = parseInt(e.target.value, 10);
        _renderHistoryTab(container);
      });

      document.getElementById('add-talent-btn')?.addEventListener('click', () => {
        _showTalentModal(null, container);
      });

      // Restore scroll position
      if (mainContent && scrollTop > 0) {
        mainContent.scrollTop = scrollTop;
      }
    } catch (err) {
      container.innerHTML = `
        <div class="text-center text-red-400 py-10">
          <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
          <p>加载人才库失败: ${err.message}</p>
        </div>
      `;
    }
  }



  // Export CSV
  function exportCSV() {
    const headers = [
      'Name', 'Position', 'Days', 'Wage', 'Status',
      'Manual Labor', 'Intelligence', 'Endurance',
      'Working Stats', 'Settled In', 'Book', 'Merits',
      'Director Education', 'Management', 'Wrong Gender',
      'Addiction', 'Inactivity', 'Total'
    ];
    const rows = employees.map(e => [
      e.name, e.position?.name || '', e.days_in_company ?? 0, e.wage ?? 0, e.status?.state || '',
      e.stats?.manual_labor ?? 0, e.stats?.intelligence ?? 0, e.stats?.endurance ?? 0,
      e.effectiveness?.working_stats ?? 0, e.effectiveness?.settled_in ?? 0,
      e.effectiveness?.book ?? 0, e.effectiveness?.merits ?? 0,
      e.effectiveness?.director_education ?? 0, e.effectiveness?.management ?? 0,
      e.effectiveness?.wrong_gender ?? 0, e.effectiveness?.addiction ?? 0,
      e.effectiveness?.inactivity ?? 0, e.effectiveness?.total ?? 0
    ]);
    Utils.exportCSV(headers, rows, `employees_${Utils.todayKey()}.csv`);
  }

  return { init, render };
})();
