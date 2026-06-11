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
      <div id="dash-alerts-panel"></div>
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
    // 使用缓存 + 统一 API（内部处理 V1/V2 差异与回退）
    await Utils.cacheCompanyTypesFromAPI();
    const data = await AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData());
    const { profile, detailed } = data;
    const companyTypeName = await Utils.resolveCompanyTypeName(profile, detailed);

    // 恢复 object 格式以兼容快照存储
    const employees = {};
    (data.employees || []).forEach(emp => { employees[emp.id || emp.player_id] = emp; });
    const stock = {};
    (data.stock || []).forEach(item => { stock[item.name] = item; });

    // 同步员工到 employees_master（幂等，不标记离职）
    await Utils.syncEmployeesMaster(data.employees || []);

    // Save snapshot（格式保持不变，兼容历史数据）
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
    this._renderInfo(profile, detailed, companyTypeName);
    this._renderStats(profile, detailed, empList);

    // Load data from DB for alerts panel
    const txs = (await DB.getAll('transactions')) || [];
    const snapshots = (await DB.getAll('snapshots')) || [];
    const stockHistory = (await DB.getAll('stock_history')) || [];

    // Load custom addiction threshold (default to 5)
    let threshold = 5;
    try {
      const stored = await DB.get('settings', 'dash_addiction_threshold');
      if (stored && stored.value != null) {
        threshold = Math.abs(Number(stored.value)) || 5;
      }
    } catch (e) { /* ignore */ }

    // Use current API stock data
    const stockItems = data.stock || [];

    await this._renderAlertsPanel(profile, detailed, empList, stockItems, txs, snapshots, stockHistory, threshold);
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

    const ratingVal = UI.starPattern(rating);

    kpis.innerHTML = [
      UI.kpiCard('star', '星级', ratingVal, `${rating}/10`, 'gold'),
      UI.kpiCard('dollar-sign', '日收入', Utils.formatMoney(daily), '每日', 'green'),
      UI.kpiCard('chart-line', '周收入', Utils.formatMoney(weekly), '每周', 'blue'),
      UI.kpiCard('users', '员工', `${hired}/${capacity}`, hired >= capacity ? '满员' : '招聘中', hired >= capacity ? 'green' : 'accent'),
      UI.kpiCard('vault', '公司资金', Utils.formatMoney(detailed.company_funds), '', 'gold'),
      UI.kpiCard('gauge', '效率', `${eff}%`, '', 'blue'),
      UI.kpiCard('heart', '人气', `${pop}`, '', 'purple'),
      UI.kpiCard('leaf', '环境', `${env}`, '', 'green'),
    ].join('');
  },

  _renderInfo(profile, detailed, companyTypeName) {
    const info = document.getElementById('dash-info');
    const fields = [
      ['公司名称', profile.name || 'N/A'],
      ['公司类型', companyTypeName || '未知'],
      ['公司天数', (profile.days_old || 0) + ' 天'],
      ['可用训练', detailed.trains_available ?? profile.trains ?? 'N/A'],
      ['广告预算', Utils.formatMoney(detailed.advertising_budget || 0)],
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
    const nowSec = Math.floor(Date.now() / 1000);
    const activeCount = empList.filter(e => {
      const ts = e.last_action?.timestamp || 0;
      return ts > 0 && (nowSec - ts) < 86400;
    }).length;
    const inactiveCount = empList.filter(e => {
      const ts = e.last_action?.timestamp || 0;
      return ts > 0 && (nowSec - ts) >= 86400;
    }).length;
    const capacity = Math.max(1, profile.employees_capacity || detailed.employees_capacity || detailed.company_size || empList.length);

    stats.innerHTML = `<h3 class="text-white font-medium mb-3"><i class="fas fa-chart-bar mr-2 text-torn-gold"></i>统计概览</h3>
      <div class="space-y-3">
        ${UI.statBar('平均效能', avgEff, 100, Utils.effColor(avgEff))}
        ${UI.statBar('员工活跃', activeCount, capacity, '#4ade80', `${activeCount}/${capacity} 人`)}
        <div class="grid grid-cols-2 gap-3 mt-3">
          <div><div class="text-gray-400 text-xs">总工资</div><div class="text-white font-medium">${Utils.formatMoney(totalWages)}</div></div>
          <div><div class="text-gray-400 text-xs">不活跃(>24h)</div><div class="text-red-400 font-medium">${inactiveCount} 人</div></div>
          <div><div class="text-gray-400 text-xs">日客户</div><div class="text-white font-medium">${(profile.daily_customers || 0).toLocaleString()}</div></div>
          <div><div class="text-gray-400 text-xs">周客户</div><div class="text-white font-medium">${(profile.weekly_customers || 0).toLocaleString()}</div></div>
        </div>
      </div>`;
  },

  async _renderAlertsPanel(profile, detailed, empList, stockItems, txs, snapshots, stockHistory, threshold) {
    const wrapper = document.getElementById('dash-alerts-panel');
    if (!wrapper) return;

    // 1. 可用训练次数预警
    const currentTrains = detailed.trains_available ?? profile.trains ?? 0;
    const rating = profile.rating || 0;
    const forecast = currentTrains + rating;

    // 2. 低库存情况 (最大余数法销量占比计算建议库存)
    const normalizeStockItem = (item) => {
      const parseQty = (v) => {
        if (v == null || v === '') return 0;
        const n = Number(String(v).replace(/,/g, ''));
        return Number.isFinite(n) ? n : 0;
      };
      return {
        name: item.name || item.title || '',
        in_stock: parseQty(item.in_stock ?? item.quantity ?? item.available ?? item.amount),
        on_order: parseQty(item.on_order ?? item.onorder ?? item.ordered ?? item.onOrder),
        sold_amount: parseQty(item.sold_amount ?? item.sold),
        cost: parseQty(item.cost ?? item.buy_price)
      };
    };
    const normalizedStocks = stockItems.map(normalizeStockItem);
    const stockCapacity = Utils.resolveStockCapacity(detailed, normalizedStocks);
    const storageSpace = stockCapacity.storageSpace;
    const itemNames = normalizedStocks.map(i => i.name);
    const weights = {};
    normalizedStocks.forEach(i => { weights[i.name] = i.sold_amount || 0; });
    const allocations = Utils.allocateStockBySales(itemNames, storageSpace, weights);

    const lowStockItems = [];
    normalizedStocks.forEach(item => {
      const total = item.in_stock + item.on_order;
      const target = allocations[item.name]?.target || 0;
      const sold = item.sold_amount || 0;
      
      let isLow = false;
      let reason = '';
      
      if (item.in_stock === 0 && item.on_order === 0) {
        isLow = true;
        reason = '无货且无在途';
      } else if (item.in_stock === 0) {
        isLow = true;
        reason = `缺货 (在途 ${item.on_order})`;
      } else if (target > 0 && total < target * 0.3) {
        isLow = true;
        reason = `库存极低 (当前 ${item.in_stock}/${target})`;
      } else if (sold > 0 && total < sold * 2) {
        isLow = true;
        reason = `预计 ${(total / sold).toFixed(1)} 天售罄 (日均销量 ${sold})`;
      }
      
      if (isLow) {
        lowStockItems.push({ name: item.name, in_stock: item.in_stock, on_order: item.on_order, target, reason });
      }
    });

    // 3. 员工缴税情况
    const weekKey = Utils.weekKey();
    const taxMap = await Utils.getEmployeeTaxStatusMap(weekKey);
    const unpaidEmps = [];
    let totalTaxDue = 0;
    let totalTaxPaid = 0;

    empList.forEach(emp => {
      const taxEntry = taxMap.get(Number(emp.player_id));
      if (taxEntry) {
        totalTaxDue += taxEntry.taxAmt || 0;
        totalTaxPaid += taxEntry.paidAmt || 0;
        const balance = taxEntry.taxAmt - taxEntry.paidAmt;
        if (balance > 0 && taxEntry.status !== 'writeoff') {
          unpaidEmps.push({
            name: emp.name || emp.player_id,
            balance
          });
        }
      }
    });

    // 4. 员工高毒瘾数量
    const highAddictEmps = [];
    empList.forEach(emp => {
      const addict = emp.effectiveness?.addiction || 0;
      if (addict <= -threshold) {
        highAddictEmps.push({
          name: emp.name || emp.player_id,
          addiction: Math.abs(addict)
        });
      }
    });

    // 5. 本周实记净利润 (混合实际历史记录 + 未来预测)
    const getTxTime = (tx) => {
      let ts = tx.timestamp || 0;
      if (ts > 0) {
        if (ts < 100000000000) ts *= 1000;
        return ts;
      }
      if (tx.date) {
        return new Date(tx.date + 'T00:00:00').getTime();
      }
      return 0;
    };
    const isTaxTx = (tx) => (tx.category === 'tax') || (tx.type === 'tax');

    const now = new Date();
    const startOfWeek = Utils.startOfCalendarWeek(now);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    const startMs = startOfWeek.getTime();
    const endMs = endOfWeek.getTime() + 86399999;
    const todayStr = Utils.todayKey();

    let weekTax = 0;
    let weekTrain = 0;
    let weekBoost = 0;
    let weekOther = 0;

    txs.forEach(tx => {
      const ts = getTxTime(tx);
      if (ts >= startMs && ts <= endMs) {
        if (isTaxTx(tx)) {
          weekTax += Number(tx.amount) || 0;
        } else if (tx.category === 'train') {
          weekTrain += Number(tx.amount) || 0;
        } else if (tx.category === 'boost') {
          weekBoost += Math.abs(Number(tx.amount) || 0);
        } else {
          weekOther += Number(tx.amount) || 0;
        }
      }
    });

    let weekIncomeAPI = 0;
    let weekCostAPI = 0;
    let weekAdFeeAPI = 0;
    let weekWagesAPI = 0;

    for (let d = new Date(startOfWeek.getTime()); d <= endOfWeek; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      
      // Cost of goods & Ad budget
      let dayCost = 0;
      let dayAd = 0;
      const dayStockHist = stockHistory.filter(h => h.date === dateStr);
      if (dayStockHist.length > 0) {
        dayStockHist.forEach(h => {
          dayCost += (Number(h.sold_amount) || 0) * (Number(h.cost) || 0);
        });
        dayAd = Number(dayStockHist[0].ad_budget) || 0;
      }
      weekCostAPI += dayCost;
      weekAdFeeAPI += dayAd;
      
      // Wages
      let dayWages = 0;
      const daySnap = snapshots.find(s => s.date === dateStr);
      if (daySnap) {
        dayWages = Number(daySnap.detailed?.daily_wages) || 0;
      }
      weekWagesAPI += dayWages;
      
      // Income
      let dayIncome = 0;
      if (daySnap) {
        dayIncome = Number(daySnap.profile?.daily_income ?? daySnap.detailed?.daily_income) || 0;
        if (dayIncome <= 0) {
          const wkInc = Number(daySnap.profile?.weekly_income ?? daySnap.detailed?.weekly_income) || 0;
          if (wkInc > 0) dayIncome = wkInc / 7;
        }
      }
      weekIncomeAPI += dayIncome;
    }

    const totalIncome = weekTax + weekTrain + weekOther + weekIncomeAPI;
    const totalExpense = weekBoost + weekCostAPI + weekAdFeeAPI + weekWagesAPI;
    const netProfit = totalIncome - totalExpense;

    // Render HTML
    wrapper.innerHTML = `
      <div class="card mb-6">
        <h3 class="text-white font-medium mb-4 flex items-center gap-2">
          <i class="fas fa-exclamation-triangle text-torn-accent"></i> 公司预警与状态面板
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          
          <!-- Card 1: Available trains warning -->
          <div class="bg-torn-surface p-4 rounded-lg border border-torn-border flex flex-col justify-between" style="min-height: 160px;">
            <div class="flex items-center gap-2 mb-2 text-torn-accent">
              <i class="fas fa-dumbbell text-lg"></i>
              <h4 class="font-bold text-sm text-white">可用训练频次</h4>
            </div>
            <div class="my-2">
              <div class="text-2xl font-bold text-white">${currentTrains} 次</div>
              <div class="text-gray-400 text-xs mt-1">明日预测: ${forecast} / ${MAX_DAILY_TRAINS} 次</div>
            </div>
            <div class="mt-2">
              ${forecast > MAX_DAILY_TRAINS 
                ? `<span class="badge badge-red flex items-center justify-center gap-1"><i class="fas fa-exclamation-triangle"></i> 即将超限</span>`
                : `<span class="badge badge-green flex items-center justify-center gap-1"><i class="fas fa-check-circle"></i> 次数安全</span>`
              }
            </div>
          </div>

          <!-- Card 2: Low stock alert -->
          <div class="bg-torn-surface p-4 rounded-lg border border-torn-border flex flex-col justify-between" style="min-height: 160px;">
            <div class="flex items-center gap-2 mb-2 text-torn-gold">
              <i class="fas fa-boxes text-lg"></i>
              <h4 class="font-bold text-sm text-white">低库存预警</h4>
            </div>
            <div class="my-2 flex-grow overflow-y-auto max-h-32 pr-1" style="min-height: 60px;">
              ${lowStockItems.length > 0 
                ? `<div class="space-y-1.5">
                     ${lowStockItems.map(item => `
                       <div class="flex justify-between items-center bg-torn-dark p-1.5 rounded border border-torn-border">
                         <div style="max-width: 65%;">
                           <div class="text-white font-medium text-xs truncate" title="${item.name}">${item.name}</div>
                           <div class="text-red-400 text-xxs truncate" title="${item.reason}">${item.reason}</div>
                         </div>
                         <div class="text-right">
                           <span class="text-red-400 font-bold text-xs">${item.in_stock.toLocaleString()}</span>
                           <span class="text-gray-500 text-xxs">/ ${item.target.toLocaleString()}</span>
                         </div>
                       </div>
                     `).join('')}
                   </div>`
                : `<div class="text-green-400 flex items-center gap-2 text-xs py-4">
                     <i class="fas fa-check-circle"></i> 所有商品库存充足
                   </div>`
              }
            </div>
          </div>

          <!-- Card 3: Employee tax status -->
          <div class="bg-torn-surface p-4 rounded-lg border border-torn-border flex flex-col justify-between" style="min-height: 160px;">
            <div class="flex items-center gap-2 mb-2 text-torn-blue">
              <i class="fas fa-file-invoice-dollar text-lg"></i>
              <h4 class="font-bold text-sm text-white">员工纳税监控</h4>
            </div>
            <div class="my-1.5">
              <div class="text-sm font-bold text-white">
                已收: <span class="text-green-400">${Utils.formatMoney(totalTaxPaid)}</span> / 应收: <span class="text-gray-400">${Utils.formatMoney(totalTaxDue)}</span>
              </div>
            </div>
            <div class="flex-grow overflow-y-auto max-h-32 pr-1" style="min-height: 50px;">
              ${unpaidEmps.length > 0
                ? `<div class="space-y-1">
                     ${unpaidEmps.map(e => `
                       <div class="flex justify-between items-center text-xs bg-torn-dark p-1 rounded border border-torn-border">
                         <span class="text-torn-accent truncate" style="max-width: 60%;">${e.name}</span>
                         <span class="text-red-400 font-mono text-xxs">欠 ${Utils.formatMoney(e.balance)}</span>
                       </div>
                     `).join('')}
                   </div>`
                : `<div class="text-green-400 flex items-center gap-2 text-xs py-4">
                     <i class="fas fa-check-circle"></i> 所有员工已缴清本周税款
                   </div>`
              }
            </div>
          </div>

          <!-- Card 4: Drug addiction monitoring -->
          <div class="bg-torn-surface p-4 rounded-lg border border-torn-border flex flex-col justify-between" style="min-height: 160px;">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2 text-torn-purple">
                <i class="fas fa-skull-crossbones text-lg"></i>
                <h4 class="font-bold text-sm text-white">员工毒瘾监控</h4>
              </div>
              <div class="flex items-center gap-1 bg-torn-dark px-1 py-0.5 rounded border border-torn-border">
                <span class="text-gray-400 text-xxs">警告阈值:</span>
                <input type="number" id="dash-addict-thresh" class="bg-torn-surface text-white border border-torn-border rounded text-center text-xxs font-bold" style="width: 38px; height: 16px; padding: 0;" value="${threshold}" min="1" max="100" />
              </div>
            </div>
            <div class="my-1.5">
              <div class="text-xs text-gray-400">高毒瘾员工数量:</div>
              <div class="text-lg font-bold text-white">
                ${highAddictEmps.length > 0 
                  ? `<span class="text-red-400">${highAddictEmps.length} 人</span>`
                  : `<span class="text-green-400">0 人</span>`
                }
              </div>
            </div>
            <div class="flex-grow overflow-y-auto max-h-32 pr-1" style="min-height: 50px;">
              ${highAddictEmps.length > 0
                ? `<div class="space-y-1">
                     ${highAddictEmps.map(e => `
                       <div class="flex justify-between items-center text-xs bg-torn-dark p-1 rounded border border-torn-border">
                         <span class="text-white truncate" style="max-width: 60%;">${e.name}</span>
                         <span class="text-red-400 font-mono text-xxs font-bold">-${e.addiction}% 效能</span>
                       </div>
                     `).join('')}
                   </div>`
                : `<div class="text-green-400 flex items-center gap-2 text-xs py-4">
                     <i class="fas fa-check-circle"></i> 效能良好，无严重毒瘾
                   </div>`
              }
            </div>
          </div>

          <!-- Card 5: Weekly net profit -->
          <div class="bg-torn-surface p-4 rounded-lg border border-torn-border flex flex-col justify-between lg:col-span-2" style="min-height: 160px;">
            <div class="flex items-center gap-2 mb-2 text-torn-green">
              <i class="fas fa-balance-scale text-lg"></i>
              <h4 class="font-bold text-sm text-white">本周已发生实记收支</h4>
            </div>
            <div class="flex flex-col md:flex-row gap-4 flex-grow justify-between">
              <div class="flex flex-col justify-center flex-grow bg-torn-dark p-3 rounded border border-torn-border" style="min-width: 140px;">
                <span class="text-xxs text-gray-400">净利润 (已发生实记)</span>
                <span class="text-xl font-bold mt-1 font-mono ${netProfit >= 0 ? 'text-green-400' : 'text-red-400'}">
                  ${netProfit >= 0 ? '+' : ''}${Utils.formatMoney(netProfit)}
                </span>
                <div class="flex justify-between text-xxs mt-2 pt-1 border-t border-torn-border">
                  <span class="text-gray-400">收入: <span class="text-green-400">${Utils.formatMoney(totalIncome)}</span></span>
                  <span class="text-gray-400 ml-2">支出: <span class="text-red-400">${Utils.formatMoney(totalExpense)}</span></span>
                </div>
              </div>
              <div class="grid grid-cols-2 gap-x-4 gap-y-1 bg-torn-dark p-2.5 rounded border border-torn-border flex-grow font-mono" style="min-width: 240px; font-size: 11px;">
                <div>
                  <div class="text-gray-500 text-xxs border-b border-torn-border pb-0.5 mb-1 font-sans">收入明细</div>
                  <div class="text-xxs text-gray-300">API销售: <span class="text-white">${Utils.formatMoney(weekIncomeAPI)}</span></div>
                  <div class="text-xxs text-gray-300">税务收取: <span class="text-white">${Utils.formatMoney(weekTax)}</span></div>
                  <div class="text-xxs text-gray-300">培训款项: <span class="text-white">${Utils.formatMoney(weekTrain)}</span></div>
                  <div class="text-xxs text-gray-300">其他手动: <span class="text-white">${Utils.formatMoney(weekOther)}</span></div>
                </div>
                <div>
                  <div class="text-gray-500 text-xxs border-b border-torn-border pb-0.5 mb-1 font-sans">支出明细</div>
                  <div class="text-xxs text-gray-300">员工薪资: <span class="text-white">${Utils.formatMoney(weekWagesAPI)}</span></div>
                  <div class="text-xxs text-gray-300">商品进货: <span class="text-white">${Utils.formatMoney(weekCostAPI)}</span></div>
                  <div class="text-xxs text-gray-300">广告费用: <span class="text-white">${Utils.formatMoney(weekAdFeeAPI)}</span></div>
                  <div class="text-xxs text-gray-300">增益购买: <span class="text-white">${Utils.formatMoney(weekBoost)}</span></div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    `;

    // Bind threshold change handler
    document.getElementById('dash-addict-thresh')?.addEventListener('change', async (e) => {
      const val = Math.max(1, Math.min(100, Math.abs(parseInt(e.target.value)) || 5));
      await DB.put('settings', { key: 'dash_addiction_threshold', value: val });
      try {
        await chrome.storage.local.set({ dash_addiction_threshold: val });
      } catch (err) { /* ignore */ }
      await this._loadAndRender();
    });
  }
};
