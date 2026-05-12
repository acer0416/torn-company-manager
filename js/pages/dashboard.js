// Dashboard Page - Company Overview
window.DashboardPage = {
  init() {},

  async render() {
    const container = document.getElementById('page-content');
    container.innerHTML = `
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <i class="fas fa-tachometer-alt text-torn-accent"></i> 公司仪表盘
        </h1>
        <button id="dash-refresh" class="btn btn-primary btn-sm">
          <i class="fas fa-sync-alt"></i> 刷新
        </button>
      </div>
      <div id="dash-kpis" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"></div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div id="dash-info" class="card"></div>
        <div id="dash-stats" class="card"></div>
      </div>
      <div id="dash-employees" class="card"></div>
    `;

    document.getElementById('dash-refresh')?.addEventListener('click', () => this.render());

    Utils.showLoading('加载公司数据...');
    try {
      await this._loadAndRender();
    } catch (err) {
      container.innerHTML = `<div class="text-center text-red-400 py-10">
        <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
        <p>加载失败: ${err.message}</p>
        <button onclick="DashboardPage.render()" class="btn btn-primary btn-sm mt-3">重试</button>
      </div>`;
    } finally {
      Utils.hideLoading();
    }
  },

  async _loadAndRender() {
    // Try V1 combined first
    let profile, employees, stock, detailed;
    try {
      const data = await TornAPI.getCompanyFull();
      profile = data.company || {};
      employees = data.company_employees || {};
      stock = data.company_stock || {};
      detailed = data.company_detailed || {};
    } catch (e) {
      // Fallback to separate calls
      const pData = await TornAPI.getCompanyProfile();
      profile = pData.company || {};
      const eData = await TornAPI.getCompanyEmployees();
      employees = {};
      (eData.employees || []).forEach(emp => { employees[emp.id] = emp; });
      const sData = await TornAPI.getCompanyStock();
      stock = {};
      (sData.stock || []).forEach(item => { stock[item.name] = item; });
      const dData = await TornAPI.getCompanyDetailed();
      detailed = dData.company_detailed || {};
    }

    // Save snapshot
    await DB.put('snapshots', {
      date: Utils.todayKey(),
      timestamp: Math.floor(Date.now() / 1000),
      profile, employees, stock, detailed
    });

    // Convert employees to array
    const empList = Object.entries(employees).map(([id, e]) => ({
      player_id: id,
      name: e.name,
      position: e.position,
      days_in_company: e.days_in_company,
      status: e.status,
      last_action: e.last_action,
      effectiveness: e.effectiveness,
      manual_labor: e.manual_labor,
      intelligence: e.intelligence,
      endurance: e.endurance,
      wage: e.wage
    }));

    this._renderKPIs(profile, detailed, empList);
    this._renderInfo(profile, detailed);
    this._renderStats(profile, detailed, empList);
    this._renderEmployees(empList);
  },

  _renderKPIs(profile, detailed, empList) {
    const kpis = document.getElementById('dash-kpis');
    const rating = profile.rating || 0;
    const daily = profile.daily_income || detailed.daily_income || 0;
    const weekly = profile.weekly_income || detailed.weekly_income || 0;
    const hired = empList.length;
    const capacity = profile.employees_capacity || detailed.company_size || 10;
    const funds = detailed.company_funds || profile.funds || 0;
    const eff = detailed.efficiency || 0;
    const pop = detailed.popularity || 0;
    const env = detailed.environment || 0;

    kpis.innerHTML = [
      UI.kpiCard('star', '星级', '⭐'.repeat(rating), `${rating}/10`, 'gold'),
      UI.kpiCard('dollar-sign', '日收入', Utils.formatMoney(daily), '每日', 'green'),
      UI.kpiCard('chart-line', '周收入', Utils.formatMoney(weekly), '每周', 'blue'),
      UI.kpiCard('users', '员工', `${hired}/${capacity}`, hired >= capacity ? '满员' : '招聘中', hired >= capacity ? 'green' : 'accent'),
      UI.kpiCard('vault', '公司资金', Utils.formatMoney(detailed.company_funds), '', 'gold'),
      UI.kpiCard('gauge', '效率', `${eff}%`, '', 'blue'),
      UI.kpiCard('heart', '人气', `${pop}`, '', 'purple'),
      UI.kpiCard('leaf', '环境', `${env}`, '', 'green'),
    ].join('');
  },

  _renderInfo(profile, detailed) {
    const info = document.getElementById('dash-info');
    const upgrades = detailed.upgrades || {};
    const fields = [
      ['公司名称', profile.name || 'N/A'],
      ['公司类型', `Type ${profile.company_type || 'N/A'}`],
      ['公司天数', (profile.days_old || 0) + ' 天'],
      ['可用训练', detailed.trains_available ?? profile.trains ?? 'N/A'],
      ['广告预算', Utils.formatMoney(detailed.advertising_budget || 0)],
      ['员工休息室', upgrades.staffroom_size || 'N/A'],
      ['仓库存储', upgrades.storage_size || 'N/A'],
      ['存储容量', (upgrades.storage_space || 0).toLocaleString()],
    ];

    info.innerHTML = `<h3 class="text-white font-medium mb-3"><i class="fas fa-info-circle mr-2 text-torn-blue"></i>公司信息</h3>
      <div class="grid grid-cols-2 gap-3">
        ${fields.map(([label, val]) => `
          <div>
            <div class="text-gray-400 text-xs">${label}</div>
            <div class="text-white text-sm font-medium">${val}</div>
          </div>
        `).join('')}
      </div>`;
  },

  _renderStats(profile, detailed, empList) {
    const stats = document.getElementById('dash-stats');
    const avgEff = empList.length > 0
      ? Math.round(empList.reduce((s, e) => s + (e.effectiveness?.total || 0), 0) / empList.length)
      : 0;
    const totalWages = empList.reduce((s, e) => s + (e.wage || 0), 0);
    const activeCount = empList.filter(e => e.last_action?.status === 'Online').length;
    const inactiveCount = empList.filter(e => {
      const ts = e.last_action?.timestamp || 0;
      return (Date.now() / 1000 - ts) > 86400;
    }).length;

    stats.innerHTML = `<h3 class="text-white font-medium mb-3"><i class="fas fa-chart-bar mr-2 text-torn-gold"></i>统计概览</h3>
      <div class="space-y-3">
        ${UI.statBar('平均效能', avgEff, 100, Utils.effColor(avgEff))}
        ${UI.statBar('在线率', activeCount, empList.length, '#4ade80', `${activeCount}/${empList.length}`)}
        <div class="grid grid-cols-2 gap-3 mt-3">
          <div><div class="text-gray-400 text-xs">总工资</div><div class="text-white font-medium">${Utils.formatMoney(totalWages)}</div></div>
          <div><div class="text-gray-400 text-xs">不活跃(>24h)</div><div class="text-red-400 font-medium">${inactiveCount} 人</div></div>
          <div><div class="text-gray-400 text-xs">日客户</div><div class="text-white font-medium">${(profile.daily_customers || 0).toLocaleString()}</div></div>
          <div><div class="text-gray-400 text-xs">周客户</div><div class="text-white font-medium">${(profile.weekly_customers || 0).toLocaleString()}</div></div>
        </div>
      </div>`;
  },

  _renderEmployees(empList) {
    const wrapper = document.getElementById('dash-employees');
    const headers = [
      { key: 'name', label: '姓名', sortable: true },
      { key: 'position', label: '职位', sortable: true },
      { key: 'status', label: '状态', sortable: true },
      { key: 'days', label: '天数', sortable: true },
      { key: 'effectiveness', label: '效能', sortable: true },
      { key: 'last_active', label: '最后活跃', sortable: true },
    ];

    const rows = empList.map(emp => {
      const state = emp.status?.state || 'Okay';
      const statusCls = { 'Okay': 'badge-green', 'Hospital': 'badge-red', 'Traveling': 'badge-blue', 'Jail': 'badge-yellow' }[state] || 'badge-gray';
      const effTotal = emp.effectiveness?.total || 0;
      return {
        id: emp.player_id,
        name: `<a href="https://www.torn.com/profiles.php?XID=${emp.player_id}" target="_blank" class="text-torn-accent hover:underline">${emp.name || emp.player_id}</a>`,
        position: typeof emp.position === 'object' ? emp.position.name : (emp.position || 'N/A'),
        status: `<span class="badge ${statusCls}">${state}</span>`,
        days: emp.days_in_company || 0,
        effectiveness: UI.statBar('', effTotal, 100, Utils.effColor(effTotal)),
        last_active: Utils.relativeTime(emp.last_action?.timestamp || 0),
        _sort_position: typeof emp.position === 'object' ? emp.position.name : emp.position,
        _sort_status: state,
        _sort_effectiveness: effTotal,
      };
    });

    wrapper.innerHTML = `<h3 class="text-white font-medium mb-3"><i class="fas fa-users mr-2 text-torn-green"></i>员工列表</h3>
      ${UI.dataTable({ headers, rows, id: 'dash-emp-table', sortable: true, emptyText: '暂无员工数据' })}`;
    UI.initSortable('dash-emp-table');
  }
};
