// Stock & Pricing Analysis Page
window.StockPage = {
  _stockData: [],
  _history: [],

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

    document.getElementById('stock-refresh')?.addEventListener('click', () => this.render());
    document.getElementById('stock-export')?.addEventListener('click', () => this._exportCSV());
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
  },

  _renderKPIs() {
    const totalStock = this._stockData.reduce((s, i) => s + (i.in_stock || 0), 0);
    const totalSold = this._stockData.reduce((s, i) => s + (i.sold_amount || 0), 0);
    const totalRevenue = this._stockData.reduce((s, i) => s + (i.sold_worth || 0), 0);
    const totalStockValue = this._stockData.reduce((s, i) => s + (i.in_stock || 0) * (i.price || 0), 0);

    document.getElementById('stock-kpis').innerHTML = [
      UI.kpiCard('boxes-stacked', '库存总量', totalStock.toLocaleString(), `${this._stockData.length} 种商品`, 'blue'),
      UI.kpiCard('shopping-cart', '已售总量', totalSold.toLocaleString(), '历史累计', 'green'),
      UI.kpiCard('dollar-sign', '总收入', Utils.formatMoney(totalRevenue), '历史累计', 'gold'),
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
      { key: 'sold_amount', label: '已售', sortable: true, render: (v) => (v||0).toLocaleString() },
      { key: 'sold_worth', label: '销售额', sortable: true, render: (v) => Utils.formatMoney(v) },
      { key: 'margin', label: '利润率', sortable: true, render: (v) => {
        const color = v >= 50 ? 'text-torn-green' : v >= 20 ? 'text-torn-gold' : 'text-red-400';
        return `<span class="${color}">${(Number(v)||0).toFixed(1)}%</span>`;
      }},
    ];

    const rows = this._stockData.map(item => ({
      ...item,
      margin: item.price > 0 ? ((item.price - item.cost) / item.price * 100) : 0
    }));

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
      const avgPrice = item.sold_amount > 0 ? Math.round(item.sold_worth / item.sold_amount) : item.price;
      const profitPerUnit = item.price - item.cost;
      const marginPct = item.price > 0 ? (profitPerUnit / item.price * 100) : 0;

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
          <div class="grid grid-cols-4 gap-3 text-center text-sm">
            <div><div class="text-gray-400 text-xs">销量</div><div class="text-white">${(item.sold_amount||0).toLocaleString()}</div></div>
            <div><div class="text-gray-400 text-xs">均价</div><div class="text-white">${Utils.formatMoney(avgPrice)}</div></div>
            <div><div class="text-gray-400 text-xs">单位利润</div><div class="text-torn-green">${Utils.formatMoney(profitPerUnit)}</div></div>
            <div><div class="text-gray-400 text-xs">库存可售</div><div class="text-white">${(item.in_stock||0).toLocaleString()}</div></div>
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

          <!-- Pricing suggestion -->
          <div class="mt-3 p-2 bg-torn-surface rounded text-sm">
            <i class="fas fa-lightbulb text-torn-gold mr-1"></i>
            <span class="text-gray-300">
              ${this._getPricingSuggestion(item, avgPrice)}
            </span>
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
    if (item.in_stock < 1000 && item.on_order === 0) {
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
    const headers = ['商品', '成本', '建议零售价', '当前售价', '库存', '在途', '已售', '销售额', '利润率%'];
    const rows = this._stockData.map(item => [
      item.name, item.cost, item.rrp, item.price, item.in_stock,
      item.on_order, item.sold_amount, item.sold_worth,
      item.price > 0 ? ((item.price - item.cost) / item.price * 100).toFixed(1) : '0'
    ]);
    Utils.exportCSV(headers, rows, `stock-${Utils.todayKey()}.csv`);
    Utils.toast('库存数据已导出', 'success');
  }
};

