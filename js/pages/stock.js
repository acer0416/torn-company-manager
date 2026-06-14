// Stock & Pricing Analysis Page
window.StockPage = {
  _stockData: [],
  _history: [],
  _stockCapacity: { storageSpace: 0, storageSize: '', itemCount: 0 },
  _stockTargets: {},

  init() {},

  async render() {
    const container = document.getElementById('page-content');
    container.innerHTML = `
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <i class="fas fa-boxes-stacked text-torn-gold"></i> 库存与定价
        </h1>
        <div class="flex gap-2">
          <button id="stock-refresh" class="btn btn-primary btn-sm">
            <i class="fas fa-sync-alt"></i> 刷新
          </button>
          <button id="stock-export" class="btn btn-secondary btn-sm">
            <i class="fas fa-download"></i> 导出CSV
          </button>
        </div>
      </div>

      <!-- Summary KPIs -->
      <div id="stock-kpis" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6"></div>

      <!-- Tabs -->
      <div id="stock-tabs" class="tab-bar mb-4"></div>

      <!-- Tab content -->
      <div id="stock-tab-content"></div>
    `;

    Utils.showLoading('加载库存数据...');
    try {
      await this._loadData();
      this._renderKPIs();
      this._renderTabs();
      this._renderInventoryTab();
    } catch (err) {
      Utils.toast('加载失败: ' + err.message, 'error');
    } finally {
      Utils.hideLoading();
    }

    document.getElementById('stock-refresh')?.addEventListener('click', () => this._refresh());
    document.getElementById('stock-export')?.addEventListener('click', () => this._exportCSV());
  },

  async _refresh() {
    AppCache.invalidate('stock');
    AppCache.invalidate('companyData');
    await this.render();
  },

  async _loadData() {
    // 使用缓存 + 统一 API（内部处理 V1/V2 回退）
    try {
      this._stockData = await AppCache.getOrFetch('stock', () => TornAPI.getStockUnified());
    } catch (e) {
      console.warn('[StockPage] Failed to load stock data:', e.message);
      this._stockData = [];
    }

    let companyData = {};
    let totalEfficiency = 0;
    try {
      companyData = await AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData());
      this._stockCapacity = Utils.resolveStockCapacity(companyData.detailed, this._stockData);
      
      if (companyData && companyData.employees) {
        const emps = Array.isArray(companyData.employees) ? companyData.employees : Object.values(companyData.employees);
        totalEfficiency = emps.reduce((sum, e) => sum + (e.effectiveness?.total || 0), 0);
      }
    } catch (e) {
      console.warn('[StockPage] Failed to load company data:', e.message);
      this._stockCapacity = Utils.resolveStockCapacity({}, this._stockData);
    }

    // Load education for pricing logic
    this._educationMultiplier = 1;
    this._completedEducation = [];
    this._currentEducationId = null;
    try {
      const eduData = await AppCache.getOrFetch('userEducation', () => TornAPI.getUserEducation());
      const completed = eduData?.education?.complete || [];
      this._completedEducation = completed;
      this._currentEducationId = eduData?.education?.current?.id || null;
      if (completed.includes(EDUCATION_IDS.BUS2700)) this._educationMultiplier += EDUCATION_PRICING_BONUS.BUS2700; // BUS2700
      if (completed.includes(EDUCATION_IDS.BUS2900)) this._educationMultiplier += EDUCATION_PRICING_BONUS.BUS2900; // BUS2900
    } catch (e) {
      console.warn('[StockPage] Failed to load user education:', e.message);
    }

    // Save to history (deduplicated)
    const today = Utils.todayKey();
    let existingHistory = await DB.getByIndex('stock_history', 'date', today) || [];
    
    // DB Cleanup: If there are multiple records for the same item today, keep only one (the one we update)
    // We'll delete the extras to prevent them from hiding the updated record.
    const seenItems = new Set();
    const toDelete = [];
    existingHistory = existingHistory.filter(h => {
      if (seenItems.has(h.item_name)) {
        toDelete.push(h.id);
        return false;
      }
      seenItems.add(h.item_name);
      return true;
    });
    
    for (const id of toDelete) {
      if (id) await DB.delete('stock_history', id);
    }
    
    for (const item of this._stockData) {
      const existingRecord = existingHistory.find(h => h.item_name === item.name);
      const record = existingRecord || {};
      
      record.item_name = item.name;
      record.date = today;
      record.in_stock = item.in_stock;
      record.cost = item.cost;
      record.rrp = item.rrp;
      
      // Save system API values
      record.sys_price = item.price;
      record.sys_sold_amount = item.sold_amount;
      record.sys_sold_worth = item.sold_worth;
      record.sys_efficiency = totalEfficiency;
      record.sys_ad_budget = Number(companyData?.detailed?.advertising_budget) || 0;
      
      // Use manual override if exists, otherwise fallback to system value
      record.price = record.manual_price ?? record.sys_price;
      record.sold_amount = record.manual_sold_amount ?? record.sys_sold_amount;
      record.sold_worth = record.manual_sold_worth ?? record.sys_sold_worth;
      record.efficiency = record.manual_efficiency ?? record.sys_efficiency;
      record.ad_budget = record.manual_ad_budget ?? record.sys_ad_budget;

      await DB.put('stock_history', record);
    }

    // Load full history for analysis, also do a one-time full DB deduplication for past dates
    const rawHistory = await DB.getAll('stock_history');
    const dedupMap = new Map();
    const allToDelete = [];
    
    for (const h of rawHistory) {
      const key = `${h.item_name}_${h.date}`;
      if (!dedupMap.has(key)) {
        dedupMap.set(key, h);
      } else {
        // We found a duplicate! Keep the one that has sys_efficiency, or higher ID
        const existing = dedupMap.get(key);
        if ((h.sys_efficiency && !existing.sys_efficiency) || (h.id > existing.id && !existing.sys_efficiency)) {
          allToDelete.push(existing.id);
          dedupMap.set(key, h);
        } else {
          allToDelete.push(h.id);
        }
      }
    }
    
    // Clean up all past duplicates in DB
    for (const id of allToDelete) {
      if (id) await DB.delete('stock_history', id);
    }
    
    this._history = Array.from(dedupMap.values());
    this._recomputeStockTargets();
  },

  /** 历史快照按日取最大当日销量，再算近 N 天均值 */
  _getHistoricalDailySales(itemName, dayWindow = 14) {
    const byDate = {};
    for (const h of this._history) {
      if (h.item_name !== itemName) continue;
      const v = Number(h.sold_amount) || 0;
      if (!byDate[h.date] || v > byDate[h.date]) byDate[h.date] = v;
    }
    const dates = Object.keys(byDate).sort().slice(-dayWindow);
    if (!dates.length) return null;
    const sum = dates.reduce((s, d) => s + byDate[d], 0);
    return sum / dates.length;
  },

  /** 分配权重：优先历史日均，否则用 API 当日销量 */
  _getSalesWeight(item) {
    const hist = this._getHistoricalDailySales(item.name);
    const today = Number(item.sold_amount) || 0;
    if (hist != null && hist > 0) return hist;
    return today;
  },

  _recomputeStockTargets() {
    const cap = this._stockCapacity.storageSpace;
    if (!cap || !this._stockData.length) {
      this._stockTargets = {};
      return;
    }
    const weights = {};
    for (const item of this._stockData) {
      weights[item.name] = this._getSalesWeight(item);
    }
    this._stockTargets = Utils.allocateStockBySales(
      this._stockData.map((i) => i.name),
      cap,
      weights
    );
  },

  _getTargetStock(itemName) {
    return this._stockTargets[itemName]?.target ?? null;
  },

  _getStockMetrics(item) {
    const inStock = item.in_stock || 0;
    const onOrder = item.on_order || 0;
    const dailyRate = Number(item.sold_amount) > 0 ? Number(item.sold_amount) : null;
    const alloc = this._stockTargets[item.name];
    const targetStock = alloc?.target ?? null;
    const sharePct = alloc?.sharePct ?? null;
    let daysLeft = null;
    if (dailyRate && dailyRate > 0) {
      const baseDays = inStock / dailyRate;
      if (baseDays > 1) {
        daysLeft = (inStock + onOrder) / dailyRate;
      } else {
        daysLeft = baseDays;
      }
    }
    const capDays = Utils.stockCapDays(targetStock, dailyRate);
    const suggestedQty = targetStock != null
      ? Math.max(0, targetStock - inStock - onOrder)
      : null;
    const restock = this._getRestockSuggestion(
      item, dailyRate, daysLeft, inStock, onOrder, targetStock, sharePct, capDays
    );
    return { dailyRate, daysLeft, capDays, targetStock, sharePct, suggestedQty, restock };
  },

  _getRestockSuggestion(item, dailyRate, daysLeft, inStock, onOrder, targetStock, sharePct, capDays) {
    const cap = this._stockCapacity.storageSpace;
    if (!cap || cap <= 0) {
      return {
        level: 'muted',
        text: '未获取公司仓库总容量 (storage_space)，请刷新或检查 API 权限'
      };
    }
    if (targetStock == null || targetStock <= 0) {
      return {
        level: 'muted',
        text: '该商品无销量记录，暂不分配仓容（其余商品按销量占比填满总仓）'
      };
    }

    const suggestedQty = Math.max(0, targetStock - inStock - onOrder);
    const capDaysText = capDays != null ? `约 ${Math.round(capDays)} 天` : '';
    const shareText = sharePct != null ? `占仓 ${Math.round(sharePct)}%` : '';

    if (inStock >= targetStock) {
      return {
        level: 'ok',
        text: `已达建议库存 ${targetStock.toLocaleString()}（${shareText}${capDaysText ? `，${capDaysText}` : ''}）`
      };
    }
    if (onOrder > 0 && (inStock + onOrder) >= targetStock) {
      return {
        level: 'info',
        text: `在途 ${onOrder.toLocaleString()}，补货后将达建议库存 ${targetStock.toLocaleString()}（${shareText}）`
      };
    }
    if (!dailyRate || dailyRate <= 0) {
      if (suggestedQty > 0) {
        return {
          level: 'warn',
          text: `无近期销量，建议补货 ${suggestedQty.toLocaleString()}（建议库存 ${targetStock.toLocaleString()}，${shareText}）`
        };
      }
      return { level: 'muted', text: `无销量权重，建议库存 ${targetStock.toLocaleString()}（${shareText}）` };
    }
    const warnDays = capDays != null ? Math.max(1, capDays * 0.5) : 1;
    if (daysLeft != null && daysLeft < warnDays && suggestedQty > 0) {
      return {
        level: 'urgent',
        text: `约 ${Math.round(daysLeft)} 天售罄，建议补货 ${suggestedQty.toLocaleString()}（补至 ${targetStock.toLocaleString()}，${shareText}${capDaysText ? `，${capDaysText}` : ''}）`
      };
    }
    if (suggestedQty > 0) {
      return {
        level: 'warn',
        text: `距建议库存还差 ${suggestedQty.toLocaleString()}（目标 ${targetStock.toLocaleString()}，${shareText}${capDaysText ? `，${capDaysText}` : ''}）`
      };
    }
    if (onOrder > 0) {
      return { level: 'info', text: `在途 ${onOrder.toLocaleString()}，接近建议库存` };
    }
    return {
      level: 'ok',
      text: `库存充足（建议 ${targetStock.toLocaleString()}，${shareText}${capDaysText ? `，${capDaysText}` : ''}）`
    };
  },

  _renderKPIs() {
    const totalStock = this._stockData.reduce((s, i) => s + (i.in_stock || 0), 0);
    const totalOnOrder = this._stockData.reduce((s, i) => s + (i.on_order || 0), 0);
    const totalSold = this._stockData.reduce((s, i) => s + (i.sold_amount || 0), 0);
    const totalRevenue = this._stockData.reduce((s, i) => s + (i.sold_worth || 0), 0);
    const totalStockValue = this._stockData.reduce((s, i) => s + (i.in_stock || 0) * (i.price || 0), 0);
    const storageCap = this._stockCapacity.storageSpace;
    const fillPct = storageCap > 0
      ? Math.min(100, (totalStock / storageCap) * 100)
      : null;
    const warehouseKpiValue = storageCap > 0
      ? `${Utils.formatShort(totalStock)} / ${Utils.formatShort(storageCap)} (${fillPct.toFixed(0)}%)`
      : totalStock.toLocaleString();
    let warehouseKpiSub = storageCap > 0
      ? `${this._stockData.length} 种商品 · 按销量占比分配`
      : (this._stockCapacity.storageSize || '请刷新获取仓库数据');
    if (storageCap > 0 && totalOnOrder > 0) {
      warehouseKpiSub += ` · 在途 ${Utils.formatShort(totalOnOrder)}`;
    }
    const lowStockCount = this._stockData.filter(i => {
      const m = this._getStockMetrics(i);
      return m.daysLeft != null && m.daysLeft < 2;
    }).length;

    document.getElementById('stock-kpis').innerHTML = [
      UI.kpiCard('warehouse', '仓库库存', warehouseKpiValue, warehouseKpiSub, storageCap ? 'gold' : 'blue'),
      UI.kpiCard('clock', '低库存预警', lowStockCount, '可售天数低于 2 天', 'red'),
      UI.kpiCard('dollar-sign', '当日销售额', Utils.formatMoney(totalRevenue), `合计 ${Utils.formatStatNum(totalSold)} 件`, 'green'),
      UI.kpiCard('warehouse', '库存价值', Utils.formatMoney(totalStockValue), '按当前售价', 'purple'),
    ].join('');
  },

  _renderTabs() {
    const tabs = [
      { id: 'inventory', label: '库存详情', icon: 'boxes-stacked' },
      { id: 'pricing-tracker', label: '定价与销售追踪', icon: 'chart-line' },
      { id: 'yata-sync', label: 'YATA 数据同步', icon: 'sync' }
    ];
    document.getElementById('stock-tabs').innerHTML = UI.tabNav(tabs, 'inventory', 'stock-tab-nav');
    // Bind tab clicks
    document.querySelectorAll('#stock-tabs .tab-item').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('#stock-tabs .tab-item').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabId = tab.dataset.tab;
        if (tabId === 'inventory') this._renderInventoryTab();
        else if (tabId === 'pricing-tracker') this._renderPricingTrackerTab();
        else if (tabId === 'yata-sync') this._renderYataSyncTab();
      };
    });
  },

  _renderInventoryTab() {
    const content = document.getElementById('stock-tab-content');
    const headers = [
      { key: 'name', label: '商品', sortable: true },
      { key: 'cost', label: '成本', sortable: true, render: (v) => Utils.formatMoney(v) },
      { key: 'rrp', label: '建议零售价', sortable: true, render: (v) => Utils.formatMoney(v) },
      { key: 'price', label: '当前售价', sortable: true, render: (v, row) => {
        const color = v >= row.rrp ? 'text-torn-green' : v >= row.cost ? 'text-torn-gold' : 'text-red-400';
        return `<span class="${color} font-medium">${Utils.formatMoney(v)}</span>`;
      }},
      { key: 'in_stock', label: '库存', sortable: true, render: (v) => {
        const cls = (v||0) < 1000 ? 'text-red-400' : (v||0) < 5000 ? 'text-torn-gold' : 'text-gray-200';
        return `<span class="${cls}">${(v||0).toLocaleString()}</span>`;
      }},
      { key: 'on_order', label: '在途', sortable: true, render: (v) => (v||0).toLocaleString() },
      { key: 'sold_amount', label: '当日销量', sortable: true, render: (v) => Utils.formatStatNum(v || 0) },
      { key: 'sold_worth', label: '当日销售额', sortable: true, render: (v) => Utils.formatMoney(v) },
      { key: 'suggested_qty', label: '建议补货', sortable: true, render: (v) => {
        if (v == null || v <= 0) return '<span class="text-gray-500">—</span>';
        return `<span class="text-torn-gold font-medium">${Utils.formatStatNum(v)}</span>`;
      }},
      { key: 'days_left', label: '可售天数', sortable: true, render: (v, row) => {
        if (v == null) return '<span class="text-gray-500">—</span>';
        const cap = row.cap_days;
        const warn = cap != null ? cap * 0.5 : 3;
        const mid = cap != null ? cap * 0.75 : 7;
        const cls = v < warn ? 'text-red-400 font-bold' : v < mid ? 'text-torn-gold' : 'text-torn-green';
        return `<span class="${cls}">${(Math.floor(v * 10) / 10).toFixed(1)} 天</span>`;
      }},
      { key: 'restock', label: '补货建议', sortable: false, render: (v) => {
        const cls = { urgent: 'text-red-400', warn: 'text-torn-gold', ok: 'text-torn-green', info: 'text-gray-300', muted: 'text-gray-500' }[v?.level] || 'text-gray-400';
        return `<span class="text-xs ${cls}">${v?.text || '—'}</span>`;
      }},
      { key: 'margin', label: '利润率', sortable: true, render: (v) => {
        const color = v >= 50 ? 'text-torn-green' : v >= 20 ? 'text-torn-gold' : 'text-red-400';
        return `<span class="${color}">${Math.round(Number(v)||0)}%</span>`;
      }},
    ];

    const rows = this._stockData.map(item => {
      const metrics = this._getStockMetrics(item);
      return {
        ...item,
        margin: item.price > 0 ? ((item.price - item.cost) / item.price * 100) : 0,
        suggested_qty: metrics.suggestedQty,
        cap_days: metrics.capDays,
        days_left: metrics.daysLeft,
        restock: metrics.restock
      };
    });

    const restockItems = rows.filter(r => r.suggested_qty > 0);
    const totalCost = restockItems.reduce((sum, r) => sum + r.suggested_qty * r.cost, 0);

    let restockButtonHtml = '';
    if (restockItems.length > 0) {
      restockButtonHtml = `
        <div class="flex justify-end mt-4">
          <button id="tcm-btn-restock" class="btn btn-primary btn-md flex items-center gap-2">
            <i class="fas fa-truck-loading"></i>
            <span>一键补货到网页端 (共 ${restockItems.length} 种商品 · 估算 ${Utils.formatMoney(totalCost)})</span>
          </button>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="card">
        <h3 class="text-white font-medium mb-3">库存明细</h3>
        ${UI.dataTable({ headers, rows, id: 'stock-table', sortable: true, emptyText: '暂无库存数据' })}
        ${restockButtonHtml}
      </div>
    `;
    UI.initSortable('stock-table');

    if (restockItems.length > 0) {
      const btn = document.getElementById('tcm-btn-restock');
      if (btn) {
        btn.onclick = () => {
          const fillData = {};
          restockItems.forEach(r => {
            fillData[r.name] = r.suggested_qty;
          });

          const jsonStr = JSON.stringify(fillData);
          const base64Str = btoa(unescape(encodeURIComponent(jsonStr)));
          const url = `https://www.torn.com/companies.php?step=your#/option=stock&tcm_fill=${encodeURIComponent(base64Str)}`;

          try {
            chrome.tabs.create({ url });
          } catch (e) {
            window.open(url, '_blank');
          }
        };
      }
    }
  },

  _getDateOffset(dateStr, offsetDays) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  },

  _formatDiff(val, isMoney = false, label = '') {
    if (!val || val === 0) return '<span class="text-gray-600 text-xs ml-2">-</span>';
    const isPositive = val > 0;
    const colorClass = isPositive ? "text-torn-green" : "text-red-400";
    const icon = isPositive ? '<i class="fas fa-caret-up"></i>' : '<i class="fas fa-caret-down"></i>';
    const text = isMoney ? Utils.formatMoney(Math.abs(val)) : Utils.formatStatNum(Math.abs(val));
    return `<span class="inline-flex items-center ml-2 ${colorClass} text-xs opacity-90" title="${label}环比">
      <span class="text-gray-500 mr-1">[${label}]</span> ${icon} ${text}
    </span>`;
  },

  _renderPricingTrackerTab() {
    const self = this;
    const content = document.getElementById('stock-tab-content');

    const completed = this._completedEducation || [];
    const currentId = this._currentEducationId;

    const pricingCourses = [
      { id: EDUCATION_IDS.BUS2700, code: 'BUS2700', name: '定价策略', effect: '+10% 售价' },
      { id: EDUCATION_IDS.BUS2900, code: 'BUS2900', name: '产品管理', effect: '+5% 售价' }
    ];

    const pricingMultiplier = (this._educationMultiplier || 1);
    const totalBonus = Math.round((pricingMultiplier - 1) * 100);

    let html = `
      <div class="card mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3">
        <div class="flex items-center gap-2">
          <i class="fas fa-graduation-cap text-torn-gold text-base"></i>
          <span class="font-bold text-white text-xs">相关教育完成情况</span>
          <span class="text-[11px] text-torn-green font-semibold ml-1 bg-green-500/10 px-2 py-0.5 rounded" style="border: 1px solid rgba(74, 222, 128, 0.2);">
            总售价提升: +${totalBonus}%
          </span>
        </div>
        <div class="flex flex-wrap gap-2">
    `;

    for (const c of pricingCourses) {
      const isCompleted = completed.includes(c.id);
      const isCurrent = currentId === c.id;

      let badgeClass = '';
      let badgeStyle = '';
      let iconHtml = '';
      let statusText = '';

      if (isCompleted) {
        badgeClass = 'bg-green-500/10 text-green-400';
        badgeStyle = 'border: 1px solid rgba(74, 222, 128, 0.2);';
        iconHtml = '<i class="fas fa-check text-[10px]"></i>';
        statusText = '已完成';
      } else if (isCurrent) {
        badgeClass = 'bg-blue-500/10 text-blue-400 animate-pulse font-semibold';
        badgeStyle = 'border: 1px solid rgba(96, 165, 250, 0.3);';
        iconHtml = '<i class="fas fa-book-open text-[10px] fa-spin"></i>';
        statusText = '学习中';
      } else {
        badgeClass = 'bg-gray-800/40 text-gray-500 opacity-60';
        badgeStyle = 'border: 1px solid rgba(156, 163, 175, 0.15);';
        iconHtml = '<i class="fas fa-lock text-[9px]"></i>';
        statusText = '未完成';
      }

      html += `
        <div class="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium font-mono ${badgeClass}" style="${badgeStyle}" title="${c.code} ${c.name} (${statusText})">
          ${iconHtml}
          <span>${c.code} ${c.name}</span>
          <span class="text-[9px] opacity-80 border-l border-current pl-1.5 ml-1">${c.effect}</span>
        </div>
      `;
    }

    html += `
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
    `;

    for (const item of this._stockData) {
      // Historical data for this item (sort descending date)
      const itemHistory = this._history
        .filter(h => h.item_name === item.name)
        .sort((a, b) => b.date.localeCompare(a.date));

      // Recommended pricing: price corresponding to the highest historical sales revenue (sold_worth)
      const salesHistory = itemHistory.filter(h => (h.sold_amount || 0) > 0 && (h.sold_worth || 0) > 0);
      let recommendedPrice = null;
      let recommendedLabel = '';

      if (salesHistory.length > 0) {
        let bestRecord = salesHistory[0];
        for (const h of salesHistory) {
          const currentWorth = h.sold_worth || 0;
          const bestWorth = bestRecord.sold_worth || 0;
          if (currentWorth > bestWorth) {
            bestRecord = h;
          } else if (currentWorth === bestWorth && (h.price || 0) > (bestRecord.price || 0)) {
            // Tie-breaker: choose the higher price
            bestRecord = h;
          }
        }
        recommendedPrice = bestRecord.price || 0;
        recommendedLabel = '建议定价 (最高营业额)';
      } else {
        recommendedPrice = Math.round((item.rrp || 0) * (this._educationMultiplier || 1));
        recommendedLabel = `建议定价 (RRP估算 x${(this._educationMultiplier || 1).toFixed(2)})`;
      }

      const adjustedRRP = Math.round((item.rrp || 0) * (this._educationMultiplier || 1));

      html += `
        <div class="card pricing-item-card transition-all duration-200 border border-gray-700 hover:border-blue-500" data-item="${item.name}">
          <div class="flex items-center justify-between cursor-pointer p-1 toggle-accordion" title="点击查看历史详情与补录">
            <div class="flex items-center gap-3">
              <div class="p-1.5 rounded bg-gray-700/50 text-gray-400 accordion-icon-bg flex items-center justify-center w-8 h-8">
                <i class="fas fa-dollar-sign text-sm"></i>
              </div>
              <div>
                <h3 class="font-bold text-sm text-white">${item.name}</h3>
                <div class="text-[11px] text-gray-400">成本: ${Utils.formatMoney(item.cost)} | 基础建议价(RRP): ${Utils.formatMoney(item.rrp)} (教育后: ${Utils.formatMoney(adjustedRRP)})</div>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <div class="bg-gray-900/50 py-1 px-3 rounded text-center" style="border: 1px solid #2a2a4a;" >
                <div class="text-[9px] uppercase text-gray-500">今日定价</div>
                <div class="text-sm font-mono text-white">${Utils.formatMoney(item.price)}</div>
              </div>
              <div class="bg-gray-900/50 py-1 px-3 rounded text-center" style="border: 1px solid #2a2a4a;" >
                <div class="text-[9px] uppercase text-gray-500">${recommendedLabel}</div>
                <div class="text-sm font-mono text-green-400 font-bold">${Utils.formatMoney(recommendedPrice)}</div>
              </div>
              <div class="text-gray-500 text-xs ml-1"><i class="fas fa-info-circle"></i></div>
            </div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    content.innerHTML = html;

    this._bindPricingTrackerEvents();
  },

  _showDetailsModal(itemName) {
    const item = this._stockData.find(i => i.name === itemName);
    if (!item) return;

    const adjustedRRP = Math.round((item.rrp || 0) * (this._educationMultiplier || 1));

    // Historical data for this item (sort descending date)
    const itemHistory = this._history
      .filter(h => h.item_name === item.name)
      .sort((a, b) => b.date.localeCompare(a.date));

    // Pre-calculate differences for chronological comparisons (since itemHistory is currently sorted desc)
    const processedRows = itemHistory.map((h, i) => {
      let dodSales = 0, dodRevenue = 0, wowSales = 0, wowRevenue = 0;
      
      // Next entry in array is yesterday (since sorted descending)
      if (i < itemHistory.length - 1) {
        const prevDay = itemHistory[i + 1];
        dodSales = h.sold_amount - prevDay.sold_amount;
        dodRevenue = h.sold_worth - prevDay.sold_worth;
      }
      
      const wowDate = this._getDateOffset(h.date, -7);
      const wowEntry = itemHistory.find(x => x.date === wowDate);
      if (wowEntry) {
        wowSales = h.sold_amount - wowEntry.sold_amount;
        wowRevenue = h.sold_worth - wowEntry.sold_worth;
      }

      return {
        id: String(h.id || `${h.item_name}_${h.date}`),
        date: h.date,
        efficiency: h.efficiency || h.sys_efficiency || 0,
        ad_budget: h.ad_budget || h.sys_ad_budget || 0,
        price: h.price,
        sold_amount: h.sold_amount,
        sold_worth: h.sold_worth,
        dodSales,
        dodRevenue,
        wowSales,
        wowRevenue,
        wowExists: !!wowEntry
      };
    });

    const tableId = `history-table-modal-${item.name.replace(/[^a-zA-Z0-9-]/g, '_')}`;
    const headers = [
      { key: 'date', label: '日期', sortable: true, render: (v) => `<span class="text-gray-400 whitespace-nowrap">${v}</span>` },
      { 
        key: 'efficiency', 
        label: '效率 & 广告费', 
        sortable: false, 
        render: (v, row) => `
          <div>
            <div class="text-yellow-500">${row.efficiency || '-'}%</div>
            <div class="text-[10px] text-gray-500">${row.ad_budget ? Utils.formatMoney(row.ad_budget) : '-'}</div>
          </div>
        `
      },
      { key: 'price', label: '定价', sortable: true, render: (v) => `<span class="font-mono text-white">$${Utils.formatStatNum(v)}</span>` },
      { 
        key: 'sold_amount', 
        label: '销量 & 变化', 
        sortable: false, 
        render: (v, row) => `
          <div class="font-mono text-gray-300">
            ${Utils.formatStatNum(v)}
            ${this._formatDiff(row.dodSales, false, '日')}
            ${row.wowExists ? this._formatDiff(row.wowSales, false, '周') : ''}
          </div>
        `
      },
      { 
        key: 'sold_worth', 
        label: '营业额 & 变化', 
        sortable: true, 
        render: (v, row) => `
          <div class="font-mono font-bold text-gray-300">
            ${Utils.formatMoney(v)}
            ${this._formatDiff(row.dodRevenue, true, '日')}
            ${row.wowExists ? this._formatDiff(row.wowRevenue, true, '周') : ''}
          </div>
        `
      }
    ];

    const historyTableHtml = UI.dataTable({
      headers,
      rows: processedRows,
      id: tableId,
      sortable: true,
      emptyText: '暂无历史记录'
    });

    const modalHtml = `
      <div class="flex justify-between items-center mb-4 pb-2 border-b border-gray-700 flex-shrink-0">
        <div>
          <h3 class="text-base font-bold text-white flex items-center gap-2">
            <i class="fas fa-chart-line text-torn-gold"></i> ${item.name} 历史与补录
          </h3>
          <div class="text-xs text-gray-400 mt-1">成本: ${Utils.formatMoney(item.cost)} | 基础建议价(RRP): ${Utils.formatMoney(item.rrp)} (教育后: ${Utils.formatMoney(adjustedRRP)})</div>
        </div>
        <button id="modal-close-btn-${item.name}" class="text-gray-400 hover:text-white text-lg"><i class="fas fa-times"></i></button>
      </div>

      <!-- Quick Adjustments & Manual Override -->
      <div class="bg-torn-surface/50 p-2.5 rounded-lg border border-gray-700/30 mb-4 flex-shrink-0">
        <div class="flex flex-col md:flex-row justify-between items-start md:items-end gap-3">
          <div class="flex-1 w-full">
            <div class="text-[11px] text-torn-gold mb-1 font-medium"><i class="fas fa-edit mr-1"></i>补录/修改记录</div>
            <div class="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
              <div>
                <label class="block text-[11px] text-gray-400 mb-0.5">日期</label>
                <input type="date" id="modal-override-date-${item.name}" class="input input-sm w-full font-mono modal-override-date-input" data-item="${item.name}" value="${Utils.todayKey()}" max="${Utils.todayKey()}" />
              </div>
              <div>
                <label class="block text-[11px] text-gray-400 mb-0.5">总效率 (%)</label>
                <input type="text" id="modal-override-eff-${item.name}" placeholder="如: 1600" class="input input-sm w-full font-mono" value="${itemHistory[0]?.efficiency || itemHistory[0]?.sys_efficiency || ''}" />
              </div>
              <div>
                <label class="block text-[11px] text-gray-400 mb-0.5">广告费 ($)</label>
                <input type="text" id="modal-override-ad-${item.name}" placeholder="如: 500000" class="input input-sm w-full font-mono" value="${itemHistory[0]?.ad_budget || itemHistory[0]?.sys_ad_budget || ''}" />
              </div>
              <div>
                <label class="block text-[11px] text-gray-400 mb-0.5">今日定价 ($)</label>
                <input type="text" id="modal-override-price-${item.name}" placeholder="售价" class="input input-sm w-full font-mono" value="${itemHistory[0]?.price || item.price || ''}" />
              </div>
              <div>
                <label class="block text-[11px] text-gray-400 mb-0.5">今日销量</label>
                <input type="text" id="modal-override-sales-${item.name}" placeholder="销量" class="input input-sm w-full font-mono" value="${itemHistory[0]?.sold_amount || item.sold_amount || ''}" />
              </div>
              <div>
                <button id="modal-save-override-btn-${item.name}" class="btn btn-primary btn-sm w-full">
                  <i class="fas fa-save mr-1"></i>保存
                </button>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-1.5 items-end">
            <span class="text-[11px] text-gray-400">快速计算器</span>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm modal-calc-price-btn" data-target="modal-override-price-${item.name}" data-multiplier="1.01"><i class="fas fa-arrow-up text-torn-green mr-1"></i>+1%</button>
              <button class="btn btn-secondary btn-sm modal-calc-price-btn" data-target="modal-override-price-${item.name}" data-multiplier="0.99"><i class="fas fa-arrow-down text-red-400 mr-1"></i>-1%</button>
            </div>
          </div>
        </div>
      </div>

      ${historyTableHtml}
    `;

    Utils.showModal(modalHtml, 'stock-details-modal');
    UI.initSortable(tableId);

    this._bindModalEvents(itemName, itemHistory, item);
  },

  _bindModalEvents(itemName, itemHistory, item) {
    // Close modal
    const closeBtn = document.getElementById(`modal-close-btn-${item.name}`);
    if (closeBtn) {
      closeBtn.onclick = () => Utils.hideModal();
    }

    // Quick price calculator inside modal
    document.querySelectorAll('.modal-calc-price-btn').forEach(btn => {
      btn.onclick = (e) => {
        const targetId = e.currentTarget.dataset.target;
        const multiplier = parseFloat(e.currentTarget.dataset.multiplier);
        const input = document.getElementById(targetId);
        if (input) {
          const currentVal = parseFloat(input.value) || 0;
          if (currentVal > 0) {
            let newVal = Math.round(currentVal * multiplier);
            if (multiplier > 1 && newVal === currentVal) newVal = currentVal + 1;
            if (multiplier < 1 && newVal === currentVal) newVal = Math.max(1, currentVal - 1);
            input.value = newVal;
            input.focus();
          }
        }
      };
    });

    // Date change to auto-populate
    const dateInput = document.getElementById(`modal-override-date-${item.name}`);
    if (dateInput) {
      dateInput.onchange = (e) => {
        const selectedDate = e.currentTarget.value;
        const record = itemHistory.find(h => h.date === selectedDate) || {};
        
        const effInput = document.getElementById(`modal-override-eff-${item.name}`);
        const adInput = document.getElementById(`modal-override-ad-${item.name}`);
        const priceInput = document.getElementById(`modal-override-price-${item.name}`);
        const salesInput = document.getElementById(`modal-override-sales-${item.name}`);
        
        if (effInput) effInput.value = record.efficiency || record.sys_efficiency || '';
        if (adInput) adInput.value = record.ad_budget || record.sys_ad_budget || '';
        if (priceInput) priceInput.value = record.price || '';
        if (salesInput) salesInput.value = record.sold_amount || '';
      };
    }

    // Save override
    const saveBtn = document.getElementById(`modal-save-override-btn-${item.name}`);
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const dateInput = document.getElementById(`modal-override-date-${item.name}`);
        const effInput = document.getElementById(`modal-override-eff-${item.name}`);
        const adInput = document.getElementById(`modal-override-ad-${item.name}`);
        const priceInput = document.getElementById(`modal-override-price-${item.name}`);
        const salesInput = document.getElementById(`modal-override-sales-${item.name}`);

        const selectedDate = dateInput ? dateInput.value : Utils.todayKey();
        if (!selectedDate) {
          Utils.toast('请选择有效的日期', 'error');
          return;
        }

        const existingHistory = await DB.getByIndex('stock_history', 'date', selectedDate) || [];
        const record = existingHistory.find(h => h.item_name === itemName) || {
          item_name: itemName, date: selectedDate
        };

        const eff = Number(effInput.value);
        const ad = Number(adInput?.value);
        const price = Number(priceInput.value);
        const sales = Number(salesInput.value);

        if (effInput.value) { record.manual_efficiency = eff; record.efficiency = eff; } else { record.manual_efficiency = null; record.efficiency = record.sys_efficiency; }
        if (adInput && adInput.value) { record.manual_ad_budget = ad; record.ad_budget = ad; } else { record.manual_ad_budget = null; record.ad_budget = record.sys_ad_budget; }
        if (priceInput.value) { record.manual_price = price; record.price = price; } else { record.manual_price = null; record.price = record.sys_price; }
        if (salesInput.value) { 
          record.manual_sold_amount = sales; 
          record.sold_amount = sales; 
          record.manual_sold_worth = price * sales;
          record.sold_worth = price * sales;
        } else {
          record.manual_sold_amount = null;
          record.sold_amount = record.sys_sold_amount;
          record.manual_sold_worth = null;
          record.sold_worth = record.sys_sold_worth;
        }

        await DB.put('stock_history', record);
        Utils.toast(`${itemName} 记录已更新`, 'success');
        
        // Refresh local history reference on StockPage
        this._history = await DB.getAll('stock_history');
        
        // Re-render main pricing tab
        this._renderPricingTrackerTab();

        // Refresh details modal content
        this._showDetailsModal(itemName);
      };
    }
  },

  _bindPricingTrackerEvents() {
    // Open details modal
    document.querySelectorAll('.toggle-accordion').forEach(btn => {
      btn.onclick = (e) => {
        const itemName = e.currentTarget.closest('.pricing-item-card').dataset.item;
        this._showDetailsModal(itemName);
      };
    });
  },

  _exportCSV() {
    const headers = ['商品', '成本', '建议零售价', '当前售价', '库存', '在途', '当日销量', '当日销售额', '建议补货', '建议库存', '仓容占比%', '可售天数', '利润率%'];
    const rows = this._stockData.map(item => {
      const m = this._getStockMetrics(item);
      return [
        item.name, item.cost, item.rrp, item.price, item.in_stock,
        item.on_order, item.sold_amount, item.sold_worth,
        m.suggestedQty != null && m.suggestedQty > 0 ? m.suggestedQty : '',
        m.targetStock != null ? m.targetStock : '',
        m.sharePct != null ? Math.round(m.sharePct).toString() : '',
        m.daysLeft != null ? Math.round(m.daysLeft).toString() : '',
        item.price > 0 ? Math.round((item.price - item.cost) / item.price * 100).toString() : '0'
      ];
    });
    Utils.exportCSV(headers, rows, `stock-${Utils.todayKey()}.csv`);
    Utils.toast('库存数据已导出', 'success');
  },

  async _renderYataSyncTab() {
    const content = document.getElementById('stock-tab-content');
    
    // Load status info
    let localCount = 0;
    try {
      localCount = await DB.count('stock_history');
    } catch (e) {
      console.warn('Failed to count stock history:', e);
    }
    
    let lastSyncText = '从未同步';
    try {
      const lastSyncSetting = await DB.get('settings', 'last_yata_sync_time');
      if (lastSyncSetting && lastSyncSetting.value) {
        lastSyncText = Utils.formatDateTime(lastSyncSetting.value);
      }
    } catch (e) {
      console.warn('Failed to get last sync time:', e);
    }
    
    content.innerHTML = `
      <div class="card space-y-4">
        <div class="border-b border-gray-700 pb-3">
          <h3 class="text-white font-medium text-lg flex items-center gap-2">
            <i class="fas fa-sync text-torn-accent"></i> YATA 数据同步
          </h3>
          <p class="text-xs text-gray-400 mt-1">
            从 YATA (yata.yt) 增量拉取公司历史销售和财务数据。系统仅会补充本地未记录的数据，不会覆盖已有记录。
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Configuration -->
          <div class="space-y-3">
            <label class="block text-xs font-semibold text-gray-400 uppercase tracking-wider">时间段选择</label>
            <div class="flex flex-wrap gap-2 mb-3">
              <button id="yata-preset-7" class="btn btn-secondary btn-sm preset-btn">最近 7 天</button>
              <button id="yata-preset-30" class="btn btn-secondary btn-sm preset-btn">最近 30 天</button>
              <button id="yata-preset-all" class="btn btn-secondary btn-sm preset-btn">全部历史</button>
              <button id="yata-preset-custom" class="btn btn-secondary btn-sm preset-btn">自定义</button>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">开始日期</label>
                <input type="date" id="yata-start-date" class="input input-sm font-mono" max="${Utils.todayKey()}" />
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">结束日期</label>
                <input type="date" id="yata-end-date" class="input input-sm font-mono" max="${Utils.todayKey()}" />
              </div>
            </div>

            <div class="pt-3">
              <button id="yata-start-sync-btn" class="btn btn-primary w-full justify-center">
                <i class="fas fa-play mr-1"></i> 开始同步
              </button>
            </div>
          </div>

          <!-- Status & Info -->
          <div class="bg-gray-900/30 border border-gray-700/50 rounded-lg p-4 flex flex-col justify-between">
            <div>
              <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">同步状态</h4>
              <div id="yata-sync-status-info" class="text-sm text-gray-300 space-y-2">
                <p>本地历史数据总量: <span id="yata-local-records-count" class="font-bold text-white font-mono">${localCount.toLocaleString()}</span> 条记录</p>
                <p>上次同步时间: <span id="yata-last-sync-time" class="text-gray-400 font-mono">${lastSyncText}</span></p>
              </div>
            </div>
            
            <!-- Progress Bar -->
            <div id="yata-sync-progress-container" class="hidden mt-4 pt-3 border-t border-gray-800">
              <div class="flex justify-between items-center text-xs mb-1">
                <span id="yata-sync-progress-label" class="text-torn-gold font-medium">准备同步...</span>
                <span id="yata-sync-progress-pct" class="font-mono text-gray-400">0%</span>
              </div>
              <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div id="yata-sync-progress-bar" class="bg-gradient-to-r from-blue-500 to-green-500 h-full transition-all duration-300" style="width: 0%"></div>
              </div>
              <div id="yata-sync-log" class="mt-2 text-[10px] text-gray-500 font-mono h-28 overflow-y-auto bg-black/30 p-2 rounded border border-gray-800/80">
                <!-- Live logs -->
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    this._bindYataSyncEvents();
  },

  _bindYataSyncEvents() {
    const startDateInput = document.getElementById('yata-start-date');
    const endDateInput = document.getElementById('yata-end-date');
    
    // Set default values (today and 7 days ago by default)
    endDateInput.value = Utils.todayKey();
    startDateInput.value = this._getDateOffset(Utils.todayKey(), -6);
    
    const presets = {
      'yata-preset-7': { days: -6 },
      'yata-preset-30': { days: -29 },
      'yata-preset-all': { start: '2015-01-01' }
    };
    
    const clearPresetActive = () => {
      document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active', 'btn-primary'));
      document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.add('btn-secondary'));
    };
    
    const setActivePreset = (id) => {
      clearPresetActive();
      const btn = document.getElementById(id);
      if (btn) {
        btn.classList.remove('btn-secondary');
        btn.classList.add('active', 'btn-primary');
      }
    };
    
    // Default preset highlights
    setActivePreset('yata-preset-7');
    
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.onclick = (e) => {
        const id = e.currentTarget.id;
        if (id === 'yata-preset-custom') {
          setActivePreset(id);
          return;
        }
        
        setActivePreset(id);
        const preset = presets[id];
        endDateInput.value = Utils.todayKey();
        if (preset.days !== undefined) {
          startDateInput.value = this._getDateOffset(Utils.todayKey(), preset.days);
        } else if (preset.start) {
          startDateInput.value = preset.start;
        }
      };
    });
    
    // If user changes inputs manually, switch to custom
    startDateInput.onchange = endDateInput.onchange = () => {
      setActivePreset('yata-preset-custom');
    };
    
    // Sync button
    const syncBtn = document.getElementById('yata-start-sync-btn');
    syncBtn.onclick = () => this._startYataSync();
  },

  async _startYataSync() {
    const startDate = document.getElementById('yata-start-date').value;
    const endDate = document.getElementById('yata-end-date').value;
    const syncBtn = document.getElementById('yata-start-sync-btn');
    const progressContainer = document.getElementById('yata-sync-progress-container');
    const progressLabel = document.getElementById('yata-sync-progress-label');
    const progressPct = document.getElementById('yata-sync-progress-pct');
    const progressBar = document.getElementById('yata-sync-progress-bar');
    const logBox = document.getElementById('yata-sync-log');
    
    if (!startDate || !endDate) {
      Utils.toast('请选择有效的开始和结束日期', 'error');
      return;
    }
    
    if (startDate > endDate) {
      Utils.toast('开始日期不能晚于结束日期', 'error');
      return;
    }
    
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> 同步中...';
    progressContainer.classList.remove('hidden');
    logBox.innerHTML = '';
    
    const log = (msg, type = 'info') => {
      const time = new Date().toLocaleTimeString();
      const color = type === 'error' ? 'text-red-400' : type === 'success' ? 'text-torn-green' : type === 'warn' ? 'text-torn-gold' : 'text-gray-400';
      logBox.innerHTML += `<div class="${color}">[${time}] ${msg}</div>`;
      logBox.scrollTop = logBox.scrollHeight;
    };
    
    log(`开始同步: ${startDate} 至 ${endDate}`, 'info');
    
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    try {
      const localRecords = await DB.getAll('stock_history');
      const originalRecordsMap = new Map();
      const runTimeRecordsMap = new Map();
      for (const r of localRecords) {
        originalRecordsMap.set(`${r.item_name}_${r.date}`, r);
        runTimeRecordsMap.set(`${r.item_name}_${r.date}`, r);
      }
      log(`本地数据库中已有 ${originalRecordsMap.size} 条历史记录`, 'info');
      
      const parsedStocks = [];
      const parsedLogs = {};
      const skippedRef = { count: 0 };
      
      // Phase 1: Fetch and parse pricing/sales (page_s)
      let sPage = 1;
      let sTotal = 1;
      log('第一阶段: 获取产品价格和销量数据...', 'info');
      
      while (true) {
        progressLabel.textContent = `获取销量数据: 第 ${sPage} / ${sTotal} 页`;
        progressBar.style.width = `${Math.min(50, Math.round((sPage / sTotal) * 50))}%`;
        progressPct.textContent = `${Math.min(50, Math.round((sPage / sTotal) * 50))}%`;
        
        log(`正在请求: pricing/sales 页码 ${sPage}...`);
        let response;
        try {
          response = await fetch(`https://yata.yt/company/supervise/?page_s=${sPage}`, { credentials: 'include' });
        } catch (fetchErr) {
          throw new Error('FETCH_FAILED');
        }
        
        if (response.status === 403) {
          throw new Error('NOT_LOGGED_IN');
        }
        
        const html = await response.text();
        let result;
        try {
          result = this._parseStocksPage(html, startDate, endDate, runTimeRecordsMap, parsedStocks, skippedRef);
        } catch (e) {
          if (e.message === 'NOT_LOGGED_IN') throw e;
          throw new Error(`解析销量数据第 ${sPage} 页失败: ${e.message}`);
        }
        
        sTotal = result.totalPages;
        log(`已解析销量页码 ${sPage}/${sTotal}。包含日期: ${result.oldestDateOnPage || '-'} 至 ${result.newestDateOnPage || '-'}. 新增/补充候选 ${parsedStocks.length} 项.`, 'info');
        
        if (result.reachedStartLimit || sPage >= sTotal) {
          log('销量数据拉取完成 (已覆盖所有日期或已达最后一页)。', 'success');
          break;
        }
        
        sPage++;
        await delay(200);
      }
      
      // Phase 2: Fetch and parse financial logs (page_d)
      let dPage = 1;
      let dTotal = 1;
      log('第二阶段: 获取广告费和公司效率数据...', 'info');
      
      while (true) {
        progressLabel.textContent = `获取财务数据: 第 ${dPage} / ${dTotal} 页`;
        progressBar.style.width = `${50 + Math.min(50, Math.round((dPage / dTotal) * 50))}%`;
        progressPct.textContent = `${50 + Math.min(50, Math.round((dPage / dTotal) * 50))}%`;
        
        log(`正在请求: logs/finance 页码 ${dPage}...`);
        let response;
        try {
          response = await fetch(`https://yata.yt/company/supervise/?page_d=${dPage}`, { credentials: 'include' });
        } catch (fetchErr) {
          throw new Error('FETCH_FAILED');
        }
        
        if (response.status === 403) {
          throw new Error('NOT_LOGGED_IN');
        }
        
        const html = await response.text();
        let result;
        try {
          result = this._parseLogsPage(html, startDate, endDate, parsedLogs);
        } catch (e) {
          if (e.message === 'NOT_LOGGED_IN') throw e;
          throw new Error(`解析财务数据第 ${dPage} 页失败: ${e.message}`);
        }
        
        dTotal = result.totalPages;
        log(`已解析财务页码 ${dPage}/${dTotal}。包含日期: ${result.oldestDateOnPage || '-'} 至 ${result.newestDateOnPage || '-'}.`, 'info');
        
        if (result.reachedStartLimit || dPage >= dTotal) {
          log('财务数据拉取完成。', 'success');
          break;
        }
        
        dPage++;
        await delay(200);
      }
      
      // Phase 3: Combine and Save
      log('第三阶段: 写入与合并本地数据库...', 'info');
      progressLabel.textContent = '写入与合并本地数据库...';
      progressBar.style.width = '100%';
      progressPct.textContent = '100%';
      
      let addedCount = 0;
      let supplementedCount = 0;
      let actualSkippedCount = 0;
      
      for (const item of parsedStocks) {
        const logData = parsedLogs[item.date] || {};
        const key = `${item.item_name}_${item.date}`;
        const existing = originalRecordsMap.get(key);
        
        if (existing) {
          let updated = false;
          
          if (!existing.cost && item.cost) { existing.cost = item.cost; updated = true; }
          if (!existing.rrp && item.rrp) { existing.rrp = item.rrp; updated = true; }
          if ((existing.in_stock === undefined || existing.in_stock === null || existing.in_stock === 0) && item.in_stock) { existing.in_stock = item.in_stock; updated = true; }
          
          if ((existing.sys_price === undefined || existing.sys_price === null || existing.sys_price === 0) && item.price) { existing.sys_price = item.price; updated = true; }
          if ((existing.sys_sold_amount === undefined || existing.sys_sold_amount === null || existing.sys_sold_amount === 0) && item.sold_amount) { existing.sys_sold_amount = item.sold_amount; updated = true; }
          if ((existing.sys_sold_worth === undefined || existing.sys_sold_worth === null || existing.sys_sold_worth === 0) && item.sold_worth) { existing.sys_sold_worth = item.sold_worth; updated = true; }
          
          if (!existing.sys_efficiency && logData.efficiency) { existing.sys_efficiency = logData.efficiency; updated = true; }
          if (!existing.sys_ad_budget && logData.ad_budget) { existing.sys_ad_budget = logData.ad_budget; updated = true; }
          
          // Fallback active fields (if manual overrides don't exist, we update active fields too)
          if (existing.price === undefined || existing.price === null || existing.price === 0) {
            existing.price = existing.manual_price ?? existing.sys_price ?? item.price;
            updated = true;
          }
          if (existing.sold_amount === undefined || existing.sold_amount === null || existing.sold_amount === 0) {
            existing.sold_amount = existing.manual_sold_amount ?? existing.sys_sold_amount ?? item.sold_amount;
            updated = true;
          }
          if (existing.sold_worth === undefined || existing.sold_worth === null || existing.sold_worth === 0) {
            existing.sold_worth = existing.manual_sold_worth ?? existing.sys_sold_worth ?? (existing.price * existing.sold_amount);
            updated = true;
          }
          if (!existing.efficiency) {
            existing.efficiency = existing.manual_efficiency ?? existing.sys_efficiency ?? logData.efficiency ?? 0;
            updated = true;
          }
          if (!existing.ad_budget) {
            existing.ad_budget = existing.manual_ad_budget ?? existing.sys_ad_budget ?? logData.ad_budget ?? 0;
            updated = true;
          }
          
          if (updated) {
            await DB.put('stock_history', existing);
            supplementedCount++;
          } else {
            actualSkippedCount++;
          }
        } else {
          // Insert brand new record
          const record = {
            item_name: item.item_name,
            date: item.date,
            in_stock: item.in_stock,
            cost: item.cost,
            rrp: item.rrp,
            
            sys_price: item.price,
            sys_sold_amount: item.sold_amount,
            sys_sold_worth: item.sold_worth,
            sys_efficiency: logData.efficiency || 0,
            sys_ad_budget: logData.ad_budget || 0,
            
            price: item.price,
            sold_amount: item.sold_amount,
            sold_worth: item.sold_worth,
            efficiency: logData.efficiency || 0,
            ad_budget: logData.ad_budget || 0
          };
          
          await DB.put('stock_history', record);
          addedCount++;
        }
      }
      
      // Update last sync time
      await DB.put('settings', { key: 'last_yata_sync_time', value: Date.now() });
      
      const totalSkipped = skippedRef.count + actualSkippedCount;
      log(`同步成功！新增记录: ${addedCount} 条, 补充记录: ${supplementedCount} 条, 跳过已完备记录: ${totalSkipped} 条.`, 'success');
      Utils.toast(`同步成功！新增 ${addedCount} 条，补充 ${supplementedCount} 条`, 'success');
      
      // Update local count and last sync time UI
      const newCount = await DB.count('stock_history');
      document.getElementById('yata-local-records-count').textContent = newCount.toLocaleString();
      document.getElementById('yata-last-sync-time').textContent = Utils.formatDateTime(Date.now());
      
      // Update history reference on StockPage
      this._history = await DB.getAll('stock_history');
      this._recomputeStockTargets();
      
    } catch (err) {
      console.error('[YataSync] Error:', err);
      let errMsg = err.message;
      if (errMsg === 'NOT_LOGGED_IN') {
        log('错误: YATA 返回 403 / 未找到数据表。请先登录 YATA 并重试。', 'error');
        Utils.showModal(`
          <div class="p-6">
            <h3 class="text-lg font-bold text-red-400 mb-3"><i class="fas fa-exclamation-triangle mr-2"></i>需要登录 YATA</h3>
            <p class="text-sm text-gray-300 mb-4">
              同步失败：未登录或无法访问 YATA。请先在同一浏览器中登录 YATA 并查看公司监控页，然后再返回同步。
            </p>
            <div class="flex gap-2 justify-end">
              <a href="https://yata.yt/company/supervise/" target="_blank" class="btn btn-primary btn-sm">前往 YATA 登录</a>
              <button onclick="Utils.hideModal()" class="btn btn-secondary btn-sm">关闭</button>
            </div>
          </div>
        `);
      } else if (errMsg === 'FETCH_FAILED') {
        log('错误: 网络请求失败。如果您在本地 test.html 中测试，可能是跨域(CORS)限制，请在已安装的扩展程序中运行。', 'error');
        Utils.toast('网络请求失败', 'error');
      } else {
        log(`同步发生错误: ${errMsg}`, 'error');
        Utils.toast(`同步失败: ${errMsg}`, 'error');
      }
    } finally {
      syncBtn.disabled = false;
      syncBtn.innerHTML = '<i class="fas fa-play mr-1"></i> 开始同步';
    }
  },

  _parseNum(str) {
    if (!str) return 0;
    const clean = str.replace(/[$,]/g, '').trim();
    const m = clean.match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  },

  _parseTotalPages(doc) {
    const currentSpan = doc.querySelector('.pagination .current');
    if (currentSpan) {
      const text = currentSpan.textContent.trim();
      const parts = text.split('/');
      if (parts.length === 2) {
        return parseInt(parts[1], 10) || 1;
      }
    }
    return 1;
  },

  _parseStocksPage(htmlText, startDate, endDate, localRecordsMap, parsedStocks, skippedRef) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    const hasStocksTable = doc.querySelector('table.company-stocks');
    if (!hasStocksTable) {
      throw new Error('NOT_LOGGED_IN');
    }
    
    const totalPages = this._parseTotalPages(doc);
    const rows = doc.querySelectorAll('table.company-stocks tbody tr.company-logs');
    let oldestDateOnPage = null;
    let newestDateOnPage = null;
    let reachedStartLimit = false;
    
    let currentDate = null;
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 10) continue;
      
      const dateText = cells[0].textContent.trim();
      if (dateText) {
        currentDate = dateText.replace(/\//g, '-');
      }
      
      if (!currentDate) continue;
      
      if (!oldestDateOnPage || currentDate < oldestDateOnPage) {
        oldestDateOnPage = currentDate;
      }
      if (!newestDateOnPage || currentDate > newestDateOnPage) {
        newestDateOnPage = currentDate;
      }
      
      if (currentDate < startDate) {
        reachedStartLimit = true;
        continue;
      }
      if (currentDate > endDate) {
        continue;
      }
      
      const itemName = cells[1].textContent.trim();
      if (!itemName) continue;
      
      const key = `${itemName}_${currentDate}`;
      const existing = localRecordsMap.get(key);
      if (existing) {
        // We only skip if the local record exists AND has all core fields filled
        const isMissingData = 
          !existing.cost || 
          !existing.rrp || 
          !existing.efficiency || 
          !existing.ad_budget ||
          existing.in_stock === undefined ||
          existing.price === undefined ||
          existing.sold_amount === undefined;
          
        if (!isMissingData) {
          skippedRef.count++;
          continue;
        }
      }
      
      // Update localRecordsMap with a dummy completed record to prevent parsing the same key multiple times
      localRecordsMap.set(key, { cost: 1, rrp: 1, efficiency: 1, ad_budget: 1, in_stock: 1, price: 1, sold_amount: 1 });
      
      const cost = this._parseNum(cells[4].textContent);
      const rrp = this._parseNum(cells[5].textContent);
      const price = this._parseNum(cells[6].textContent);
      const sold_amount = this._parseNum(cells[7].textContent);
      const sold_worth = this._parseNum(cells[8].textContent);
      const in_stock = this._parseNum(cells[9].textContent);
      
      parsedStocks.push({
        date: currentDate,
        item_name: itemName,
        cost,
        rrp,
        price,
        sold_amount,
        sold_worth,
        in_stock
      });
    }
    
    return { totalPages, oldestDateOnPage, newestDateOnPage, reachedStartLimit };
  },

  _parseLogsPage(htmlText, startDate, endDate, parsedLogs) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    
    const hasLogsTable = doc.querySelector('table.company-logs');
    if (!hasLogsTable) {
      throw new Error('NOT_LOGGED_IN');
    }
    
    const totalPages = this._parseTotalPages(doc);
    const rows = doc.querySelectorAll('table.company-logs tbody tr.company-logs');
    let oldestDateOnPage = null;
    let newestDateOnPage = null;
    let reachedStartLimit = false;
    
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 13) continue;
      
      const dateText = cells[0].textContent.trim();
      if (!dateText) continue;
      
      const currentDate = dateText.replace(/\//g, '-');
      
      if (!oldestDateOnPage || currentDate < oldestDateOnPage) {
        oldestDateOnPage = currentDate;
      }
      if (!newestDateOnPage || currentDate > newestDateOnPage) {
        newestDateOnPage = currentDate;
      }
      
      if (currentDate < startDate) {
        reachedStartLimit = true;
        continue;
      }
      if (currentDate > endDate) {
        continue;
      }
      
      const ad_budget = this._parseNum(cells[2].textContent);
      const efficiency = this._parseNum(cells[6].textContent);
      
      parsedLogs[currentDate] = { ad_budget, efficiency };
    }
    
    return { totalPages, oldestDateOnPage, newestDateOnPage, reachedStartLimit };
  }
};

