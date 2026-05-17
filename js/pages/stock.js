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

    // Save to history
    const today = Utils.todayKey();
    for (const item of this._stockData) {
      await DB.put('stock_history', {
        item_name: item.name,
        date: today,
        price: item.price,
        in_stock: item.in_stock,
        sold_amount: item.sold_amount,
        sold_worth: item.sold_worth,
        cost: item.cost,
        rrp: item.rrp
      });
    }

    // Load history
    this._history = await DB.getAll('stock_history');

    try {
      const companyData = await AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData());
      this._stockCapacity = Utils.resolveStockCapacity(companyData.detailed, this._stockData);
    } catch (e) {
      console.warn('[StockPage] Failed to load company storage capacity:', e.message);
      this._stockCapacity = Utils.resolveStockCapacity({}, this._stockData);
    }
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
      daysLeft = inStock / dailyRate;
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
    const capDaysText = capDays != null ? `约 ${capDays.toFixed(1)} 天` : '';
    const shareText = sharePct != null ? `占仓 ${sharePct.toFixed(1)}%` : '';

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
        text: `约 ${daysLeft.toFixed(1)} 天售罄，建议补货 ${suggestedQty.toLocaleString()}（补至 ${targetStock.toLocaleString()}，${shareText}${capDaysText ? `，${capDaysText}` : ''}）`
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
      const target = m.targetStock;
      if (target && (i.in_stock || 0) + (i.on_order || 0) < target * 0.5) return true;
      if (m.capDays != null && m.daysLeft != null && m.daysLeft < m.capDays * 0.5) return true;
      return false;
    }).length;

    document.getElementById('stock-kpis').innerHTML = [
      UI.kpiCard('warehouse', '仓库库存', warehouseKpiValue, warehouseKpiSub, storageCap ? 'gold' : 'blue'),
      UI.kpiCard('clock', '低库存预警', lowStockCount, '低于容量 50%', lowStockCount > 0 ? 'red' : 'green'),
      UI.kpiCard('dollar-sign', '当日销售额', Utils.formatMoney(totalRevenue), `合计 ${Utils.formatStatNum(totalSold)} 件`, 'gold'),
      UI.kpiCard('warehouse', '库存价值', Utils.formatMoney(totalStockValue), '按当前售价', 'purple'),
    ].join('');
  },

  _renderTabs() {
    const tabs = [
      { id: 'inventory', label: '库存详情', icon: 'boxes-stacked' },
      { id: 'pricing', label: '定价分析', icon: 'chart-line' },
      { id: 'history', label: '历史趋势', icon: 'clock-rotate-left' },
    ];
    document.getElementById('stock-tabs').innerHTML = UI.tabNav(tabs, 'inventory', 'stock-tab-nav');
    // Bind tab clicks
    document.querySelectorAll('#stock-tabs .tab-item').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('#stock-tabs .tab-item').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabId = tab.dataset.tab;
        if (tabId === 'inventory') this._renderInventoryTab();
        else if (tabId === 'pricing') this._renderPricingTab();
        else if (tabId === 'history') this._renderHistoryTab();
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
        return `<span class="${cls}">${v.toFixed(1)} 天</span>`;
      }},
      { key: 'restock', label: '补货建议', sortable: false, render: (v) => {
        const cls = { urgent: 'text-red-400', warn: 'text-torn-gold', ok: 'text-torn-green', info: 'text-gray-300', muted: 'text-gray-500' }[v?.level] || 'text-gray-400';
        return `<span class="text-xs ${cls}">${v?.text || '—'}</span>`;
      }},
      { key: 'margin', label: '利润率', sortable: true, render: (v) => {
        const color = v >= 50 ? 'text-torn-green' : v >= 20 ? 'text-torn-gold' : 'text-red-400';
        return `<span class="${color}">${(Number(v)||0).toFixed(1)}%</span>`;
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

    content.innerHTML = `
      <div class="card">
        <h3 class="text-white font-medium mb-3">库存明细</h3>
        ${UI.dataTable({ headers, rows, id: 'stock-table', sortable: true, emptyText: '暂无库存数据' })}
      </div>
    `;
    UI.initSortable('stock-table');
  },

  _renderPricingTab() {
    const content = document.getElementById('stock-tab-content');
    let html = '<div class="space-y-4">';

    for (const item of this._stockData) {
      const metrics = this._getStockMetrics(item);
      const avgPrice = item.sold_amount > 0 ? Math.round(item.sold_worth / item.sold_amount) : item.price;
      const profitPerUnit = item.price - item.cost;
      const marginPct = item.price > 0 ? (profitPerUnit / item.price * 100) : 0;
      const daysText = metrics.daysLeft != null ? `${metrics.daysLeft.toFixed(1)} 天` : '—';

      // Price range indicator
      const priceMin = item.cost;
      const priceMax = item.rrp * 1.5;
      const pricePos = Math.min(100, Math.max(0, ((item.price - priceMin) / (priceMax - priceMin)) * 100));

      // Historical price data for this item
      const itemHistory = this._history
        .filter(h => h.item_name === item.name)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14);

      html += `
        <div class="card">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-white font-medium">${item.name}</h3>
            <div class="flex gap-2 text-xs">
              <span class="badge badge-green">成本 ${Utils.formatMoney(item.cost)}</span>
              <span class="badge badge-blue">建议价 ${Utils.formatMoney(item.rrp)}</span>
              <span class="badge ${marginPct >= 30 ? 'badge-green' : marginPct >= 10 ? 'badge-yellow' : 'badge-red'}">
                利润率 ${(Number(marginPct)||0).toFixed(1)}%
              </span>
            </div>
          </div>

          <!-- Price position bar -->
          <div class="mb-3">
            <div class="flex justify-between text-xs text-gray-400 mb-1">
              <span>成本价</span><span>建议价</span><span>溢价区</span>
            </div>
            <div class="h-3 bg-torn-surface rounded-full relative">
              <div class="absolute h-3 rounded-full" style="width:100%; background: linear-gradient(90deg, #ef4444 0%, #facc15 30%, #4ade80 60%, #60a5fa 100%); opacity:0.3;"></div>
              <div class="absolute top-0 w-3 h-3 bg-white rounded-full shadow-lg border-2 border-torn-accent" style="left:${pricePos}%; transform:translateX(-50%);"></div>
            </div>
            <div class="text-center text-sm text-white mt-1">当前售价: ${Utils.formatMoney(item.price)}</div>
          </div>

          <!-- Stats row -->
          <div class="grid grid-cols-2 md:grid-cols-6 gap-3 text-center text-sm">
            <div><div class="text-gray-400 text-xs">当日销量</div><div class="text-white">${Utils.formatStatNum(item.sold_amount || 0)}</div></div>
            <div><div class="text-gray-400 text-xs">均价</div><div class="text-white">${Utils.formatMoney(avgPrice)}</div></div>
            <div><div class="text-gray-400 text-xs">单位利润</div><div class="text-torn-green">${Utils.formatMoney(profitPerUnit)}</div></div>
            <div><div class="text-gray-400 text-xs">建议库存</div><div class="text-white">${metrics.targetStock != null ? Utils.formatStatNum(metrics.targetStock) : '—'}${metrics.sharePct != null ? ` (${metrics.sharePct.toFixed(1)}%)` : ''}</div></div>
            <div><div class="text-gray-400 text-xs">建议补货</div><div class="text-torn-gold">${metrics.suggestedQty != null && metrics.suggestedQty > 0 ? Utils.formatStatNum(metrics.suggestedQty) : '—'}</div></div>
            <div><div class="text-gray-400 text-xs">可售天数</div><div class="text-white">${daysText}</div></div>
          </div>

          <!-- Simple price history chart -->
          ${itemHistory.length > 1 ? `
            <div class="mt-3">
              <div class="text-xs text-gray-400 mb-1">价格趋势 (近14天)</div>
              <div class="flex items-end gap-1 h-16">
                ${itemHistory.map(h => {
                  const maxP = Math.max(...itemHistory.map(x => x.price));
                  const minP = Math.min(...itemHistory.map(x => x.price));
                  const range = maxP - minP || 1;
                  const pct = ((h.price - minP) / range) * 100;
                  return `<div class="flex-1 bg-torn-accent rounded-t opacity-80" style="height:${Math.max(10, pct)}%" data-tooltip="${h.date}: ${Utils.formatMoney(h.price)}"></div>`;
                }).join('')}
              </div>
              <div class="flex justify-between text-xs text-gray-500 mt-1">
                <span>${itemHistory[0]?.date || ''}</span>
                <span>${itemHistory[itemHistory.length - 1]?.date || ''}</span>
              </div>
            </div>
          ` : ''}

          <!-- Pricing & restock suggestion -->
          <div class="mt-3 p-2 bg-torn-surface rounded text-sm space-y-1">
            <div><i class="fas fa-lightbulb text-torn-gold mr-1"></i><span class="text-gray-300">${this._getPricingSuggestion(item, avgPrice)}</span></div>
            <div><i class="fas fa-truck text-torn-accent mr-1"></i><span class="text-gray-300">${metrics.restock.text}</span></div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    content.innerHTML = html;
  },

  _getPricingSuggestion(item, avgPrice) {
    const margin = item.price > 0 ? (item.price - item.cost) / item.price * 100 : 0;

    if (margin < 10) {
      return `利润率过低 (${(Number(margin)||0).toFixed(1)}%)，建议提价至 ${Utils.formatMoney(Math.ceil(item.cost / 0.7))} 以上 (30%利润率)`;
    }
    const target = this._getTargetStock(item.name);
    if (target && (item.in_stock || 0) + (item.on_order || 0) < target * 0.5 && item.on_order === 0) {
      return '库存不足且无在途订单，建议尽快补货';
    }
    if (item.price > item.rrp * 1.2) {
      return `当前售价高于建议价 ${(item.rrp ? (item.price / item.rrp - 1) * 100 : 0).toFixed(0)}%，可能影响销量`;
    }
    if (item.price < item.rrp * 0.8) {
      return `当前售价低于建议价，可考虑提价至 ${Utils.formatMoney(item.rrp)} 以增加利润`;
    }
    return '定价合理，利润率良好';
  },

  _renderHistoryTab() {
    const content = document.getElementById('stock-tab-content');
    const dates = [...new Set(this._history.map(h => h.date))].sort().slice(-30);

    if (dates.length === 0) {
      content.innerHTML = UI.emptyState('clock-rotate-left', '暂无历史数据，数据将在每次访问时自动记录');
      return;
    }

    let html = `
      <div class="card">
        <h3 class="text-white font-medium mb-3">历史库存变化 (近30天)</h3>
        <div class="overflow-x-auto">
          <table class="data-table">
            <thead>
              <tr>
                <th>商品</th>
                ${dates.map(d => `<th class="text-center">${d.slice(5)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
    `;

    for (const item of this._stockData) {
      const itemHist = this._history.filter(h => h.item_name === item.name);
      const histMap = {};
      for (const h of itemHist) histMap[h.date] = h;

      html += `<tr><td class="font-medium text-white">${item.name}</td>`;
      for (const d of dates) {
        const h = histMap[d];
        if (h) {
          const prevDate = dates[dates.indexOf(d) - 1];
          const prev = prevDate ? histMap[prevDate] : null;
          const change = prev ? h.sold_amount - prev.sold_amount : 0;
          const color = change > 0 ? 'text-torn-green' : change < 0 ? 'text-red-400' : 'text-gray-400';
          html += `<td class="text-center text-xs"><span class="${color}">${(h.in_stock||0).toLocaleString()}</span></td>`;
        } else {
          html += '<td class="text-center text-gray-600">-</td>';
        }
      }
      html += '</tr>';
    }

    html += '</tbody></table></div></div>';
    content.innerHTML = html;
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
        m.sharePct != null ? m.sharePct.toFixed(1) : '',
        m.daysLeft != null ? m.daysLeft.toFixed(1) : '',
        item.price > 0 ? ((item.price - item.cost) / item.price * 100).toFixed(1) : '0'
      ];
    });
    Utils.exportCSV(headers, rows, `stock-${Utils.todayKey()}.csv`);
    Utils.toast('库存数据已导出', 'success');
  }
};

