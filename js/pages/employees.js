// Employees Page - 员工管理
window.EmployeePage = (() => {
  let employees = [];
  let notes = {};
  let currentTab = 'basic';
  let sortCol = 'name';
  let sortAsc = true;
  let filterText = '';

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

    document.getElementById('emp-refresh')?.addEventListener('click', () => render());
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
    const data = await AppCache.getOrFetch('employees', () => TornAPI.getEmployeesUnified());
    employees = data;

    // Save snapshots to employee_history
    const today = Utils.todayKey();
    for (const emp of employees) {
      await DB.put('employee_history', {
        player_id: emp.id,
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
    }

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

    // Mark leaving employees
    for (const m of existingMasters) {
      if (!currentIds.has(Number(m.player_id)) && !m.left_date) {
        m.left_date = today;
        await DB.put('employees_master', m);
      }
    }

    // Load notes
    notes = {};
    const noteRecords = await DB.getAll('employee_notes');
    noteRecords.forEach(n => { notes[n.player_id] = n.note || ''; });

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
      { id: 'notes', label: '备注', icon: 'fas fa-sticky-note' }
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
      addiction: emp.status?.details || '',
      last_action: emp.last_action?.timestamp || 0,
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
  }

  function _empProfileLink(emp) {
    return `<a href="https://www.torn.com/profiles.php?XID=${emp.id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`;
  }

  // Tab 1 - 基本信息
  function _renderBasic(container, list) {
    const rows = list.map(emp => {
      const statusState = emp.status?.state || 'Okay';
      const addiction = emp.status?.details || 'None';
      const lastTs = emp.last_action?.timestamp || 0;
      return {
        name: _empProfileLink(emp),
        position: emp.position?.name || '-',
        days: emp.days_in_company ?? 0,
        wage: Utils.formatMoney(emp.wage ?? 0),
        status: `<span class="badge ${Utils.statusDotClass(statusState)}">${statusState}</span>`,
        addiction: `<span class="badge ${Utils.addictionColor(addiction)}">${addiction}</span>`,
        last_action: Utils.relativeTime(lastTs),
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
        { key: 'addiction', label: _sortHeader('毒瘾', 'addiction') },
        { key: 'last_action', label: _sortHeader('最后活跃', 'last_action') },
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

    const rows = list.map(emp => {
      const eff = emp.effectiveness || {};
      const row = { name: _empProfileLink(emp), id: emp.id };
      effFields.forEach(f => {
        const val = eff[f.key] ?? 0;
        if (f.key === 'total') {
          row[f.key] = UI.statBar('', val, 100, '#e94560', true);
        } else {
          row[f.key] = `<span class="font-mono ${Utils.effColor(val)}">${val}</span>`;
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
      return {
        name: _empProfileLink(emp),
        manual_labor: `<span class="font-mono">${ml}</span>`,
        intelligence: `<span class="font-mono">${intel}</span>`,
        endurance: `<span class="font-mono">${end}</span>`,
        id: emp.id
      };
    });

    // Totals row
    rows.push({
      name: '<strong class="text-white">合计</strong>',
      manual_labor: `<strong class="text-torn-gold font-mono">${totalML}</strong>`,
      intelligence: `<strong class="text-torn-gold font-mono">${totalInt}</strong>`,
      endurance: `<strong class="text-torn-gold font-mono">${totalEnd}</strong>`,
      id: 'totals'
    });

    container.innerHTML = UI.dataTable({
      id: 'emp-stats-table',
      sortable: false,
      emptyText: '无属性数据',
      headers: [
        { key: 'name', label: _sortHeader('姓名', 'name') },
        { key: 'manual_labor', label: _sortHeader('手动劳动', 'manual_labor') },
        { key: 'intelligence', label: _sortHeader('智力', 'intelligence') },
        { key: 'endurance', label: _sortHeader('耐力', 'endurance') },
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
