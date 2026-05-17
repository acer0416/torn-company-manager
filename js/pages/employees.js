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
        player_id: Number(emp.id || emp.player_id),
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
          note: notes[pid] || notes[emp?.id] || m.archive?.note || ''
        };
        await DB.put('employees_master', m);
      }
    }

    // notes already loaded above

    taxStatusMap = await Utils.getEmployeeTaxStatusMap(Utils.weekKey());

    dailyXanMap = new Map();
    try {
      const rehabCfgs = await DB.getAll('rehab_config') || [];
      rehabCfgs.forEach((c) => {
        if (c.daily_xan != null && !Number.isNaN(Number(c.daily_xan))) {
          dailyXanMap.set(Number(c.player_id), Number(c.daily_xan));
        }
      });
    } catch (e) { /* optional */ }

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
      { id: 'history', label: '历史员工', icon: 'fas fa-history' }
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

  async function _enrichDailyXan(list) {
    const need = list.filter((emp) => {
      const pid = Number(emp.id || emp.player_id);
      return pid && !dailyXanMap.has(pid);
    });
    if (!need.length) return;

    for (const emp of need.slice(0, 8)) {
      const pid = Number(emp.id || emp.player_id);
      try {
        const ps = await TornAPI.getPlayerPersonalStats(pid);
        const daily = Utils.dailyXanFromPersonalStats(ps);
        if (daily != null) {
          dailyXanMap.set(pid, daily);
          await DB.put('rehab_config', {
            player_id: pid,
            daily_xan: daily,
            updated_at: Date.now()
          });
        } else {
          dailyXanMap.set(pid, 0);
        }
      } catch (e) {
        dailyXanMap.set(pid, 0);
      }
    }
    if (currentTab === 'basic') _renderContent();
  }

  function _empProfileLink(emp) {
    return `<a href="https://www.torn.com/profiles.php?XID=${emp.id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`;
  }

  // Tab 1 - 基本信息
  function _renderBasic(container, list) {
    const rows = list.map(emp => {
      const statusState = emp.status?.state || 'Okay';
      const dailyXan = dailyXanMap.get(Number(emp.id));
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
        last_action: Utils.relativeTime(lastTs),
        effectiveness: `<span class="text-gray-400 font-mono">${effVal}</span>`,
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
      const merit = emp.effectiveness?.merits ?? 0;
      return {
        name: _empProfileLink(emp),
        manual_labor: `<span class="font-mono">${Utils.formatStatNum(ml)}</span>`,
        intelligence: `<span class="font-mono">${Utils.formatStatNum(intel)}</span>`,
        endurance: `<span class="font-mono">${Utils.formatStatNum(end)}</span>`,
        merits: `<span class="font-mono ${Utils.effColor(merit)}">${merit}</span>`,
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
      note: arch.note || notes[pid] || '',
      total_stats: arch.total_stats ?? null
    };
  }

  async function _enrichFormerTotalStats(leftEmployees, containerEl) {
    for (const emp of leftEmployees.slice(0, 6)) {
      const pid = Number(emp.player_id);
      const cell = containerEl.querySelector(`[data-total-stats-pid="${pid}"]`);
      if (!cell || cell.dataset.loaded === '1') continue;
      const arch = emp.archive || {};
      if (arch.total_stats != null && arch.total_stats_source === 'hof_workstats') {
        cell.textContent = Utils.formatStatNum(arch.total_stats);
        cell.dataset.loaded = '1';
        continue;
      }
      try {
        const total = await TornAPI.getPlayerTotalStats(pid);
        if (total != null) {
          arch.total_stats = total;
          arch.total_stats_source = 'hof_workstats';
          emp.archive = arch;
          await DB.put('employees_master', emp);
          cell.textContent = Utils.formatStatNum(total);
        } else {
          cell.textContent = 'N/A';
        }
      } catch (e) {
        cell.textContent = 'N/A';
      }
      cell.dataset.loaded = '1';
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
          <div><label class="text-gray-400 block mb-1">效能</label><input class="input" type="number" id="former-eff" value="${a.effectiveness === 'N/A' ? '' : a.effectiveness}" /></div>
          <div><label class="text-gray-400 block mb-1">工资 ($)</label><input class="input" type="text" id="former-wage" value="${a.wage}" /></div>
          <div class="grid grid-cols-3 gap-2">
            <div><label class="text-gray-400 block mb-1">手动劳动</label><input class="input" type="number" id="former-ml" value="${a.manual_labor}" /></div>
            <div><label class="text-gray-400 block mb-1">智力</label><input class="input" type="number" id="former-int" value="${a.intelligence}" /></div>
            <div><label class="text-gray-400 block mb-1">耐力</label><input class="input" type="number" id="former-end" value="${a.endurance}" /></div>
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


  // Tab 5 - 历史员工
  async function _renderHistoryTab(container) {
    try {
      const allHistory = await DB.getAll('employee_history');
      const allMasters = await DB.getAll('employees_master');

      const leftEmployees = allMasters.filter(m => m.left_date !== null && m.left_date !== undefined);

      if (leftEmployees.length === 0) {
        container.innerHTML = UI.emptyState('fas fa-ghost', '暂无历史员工');
        return;
      }

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
        const totalStats = a.total_stats != null ? Utils.formatStatNum(a.total_stats) : '…';
        const hasData = a.effectiveness !== 'N/A' || a.manual_labor || a.intelligence || a.endurance || a.wage;
        const hint = hasData ? '' : ' <span class="text-xs text-gray-500">(可编辑补全)</span>';

        return {
          name: `<span class="text-gray-300">${emp.name || 'Unknown'}</span>${hint}`,
          position: a.position,
          days: a.days,
          effectiveness: `<span class="text-gray-400 font-mono">${a.effectiveness}</span>`,
          wage: Utils.formatCurrency(a.wage),
          stats: `<span class="text-gray-400 font-mono">${statsDisplay}</span>`,
          total_stats: `<span class="text-gray-400 font-mono" data-total-stats-pid="${a.pid}">${totalStats}</span>`,
          merit: `<span class="text-gray-400">${meritMap.has(a.pid) ? meritMap.get(a.pid) : 'N/A'}</span>`,
          note: `<span class="text-gray-400 text-xs">${a.note || '—'}</span>`,
          left_date: emp.left_date || '-',
          actions: `<button class="btn btn-xs btn-secondary emp-edit-former" data-pid="${a.pid}"><i class="fas fa-edit"></i> 编辑</button>`,
          id: a.pid
        };
      });

      container.innerHTML = UI.dataTable({
        id: 'emp-history-table',
        sortable: false,
        emptyText: '暂无历史员工',
        headers: [
          { key: 'name', label: '姓名' },
          { key: 'position', label: '职位' },
          { key: 'days', label: '在职天数' },
          { key: 'effectiveness', label: '效能' },
          { key: 'wage', label: '工资' },
          { key: 'stats', label: '属性值 (劳/智/耐)' },
          { key: 'total_stats', label: '总属性值' },
          { key: 'merit', label: 'Merit' },
          { key: 'note', label: '备注' },
          { key: 'left_date', label: '离职日期' },
          { key: 'actions', label: '操作' },
        ],
        rows
      });

      container.querySelectorAll('.emp-edit-former').forEach(btn => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.dataset.pid);
          const emp = leftEmployees.find(m => Number(m.player_id) === pid);
          if (emp) _showFormerEmployeeModal(emp, allHistory, container);
        });
      });

      _enrichFormerTotalStats(leftEmployees, container);
    } catch (err) {
      container.innerHTML = `
        <div class="text-center text-red-400 py-10">
          <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
          <p>加载历史员工失败: ${err.message}</p>
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
