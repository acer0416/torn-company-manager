// Utility functions
const Utils = {
  // Format money with commas
  formatMoney(n) {
    if (n == null) return '-';
    return '$' + Number(n).toLocaleString();
  },

  // Format number with k/m suffix
  formatShort(n) {
    if (n == null) return '-';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
  },

  /** 属性值等：≥1000 显示为 k 近似 */
  formatStatNum(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return '-';
    const num = Number(n);
    if (Math.abs(num) >= 1000) return this.formatShort(num);
    return num.toLocaleString();
  },

  formatPosition(position) {
    if (!position) return 'N/A';
    if (typeof position === 'object') {
      return position.name || position.title || position.position || 'N/A';
    }
    return String(position);
  },

  COMPANY_TYPE_NAMES: {
    1: '花店', 2: '甜甜圈店', 3: '肉店', 4: '蜡烛店', 5: '餐厅',
    6: '软件公司', 7: '建筑公司', 8: '律所', 9: '汽车经销商', 10: '杂货店',
    11: '服装店', 12: '茶馆', 13: '游戏店', 14: '制药公司', 15: '农业公司',
    16: '物流公司', 17: '采矿公司', 18: '安保公司', 19: '健身中心', 20: '洗车店',
    21: '商场', 22: '加油站', 23: '夜总会', 24: '成人用品店', 25: '眼镜店',
    26: '动物园', 27: '宠物店', 28: '珠宝店', 29: '蔬菜摊', 30: '家具店',
    31: '音乐店', 32: '房地产公司', 33: '回收中心', 34: '殡仪馆', 35: '博物馆',
    36: '电视台', 37: '烟草店', 38: '玩具店', 39: '书店', 40: '旅行公司',
    41: '炼油厂', 42: '鞋店', 43: '五金店', 44: '美容院',
    45: '美食超市', 46: '数码店', 47: '维修店', 48: '码头'
  },

  async cacheCompanyTypesFromAPI() {
    try {
      const existing = await DB.getAll('company_types');
      if (existing && existing.length >= 40) return;
      const data = await TornAPI.getCompanyTypes();
      const companies = data?.companies || data?.company_types || data?.torn?.companies || {};
      const entries = Array.isArray(companies) ? companies : Object.entries(companies);
      for (const entry of entries) {
        let id, info;
        if (Array.isArray(entry)) {
          id = Number(entry[0]);
          info = entry[1];
        } else {
          id = Number(entry.id || entry.type_id);
          info = entry;
        }
        if (!id) continue;
        const name = info?.name || info?.title || info?.company_type || `类型 ${id}`;
        await DB.put('company_types', { type_id: id, name, raw: info });
      }
    } catch (e) {
      console.warn('[Utils] cacheCompanyTypesFromAPI:', e.message);
    }
  },

  async resolveCompanyTypeName(profile, detailed) {
    const raw = profile?.company_type ?? profile?.type ?? profile?.companyType
      ?? detailed?.company_type ?? detailed?.type ?? detailed?.companyType;
    if (raw == null || raw === '') return '未知';
    if (typeof raw === 'string' && Number.isNaN(Number(raw))) return raw;
    if (typeof raw === 'object') {
      return raw.name || raw.title || raw.type || this.formatPosition(raw) || '未知';
    }
    const id = Number(raw);
    if (!id) return String(raw);
    try {
      const row = await DB.get('company_types', id);
      if (row?.name) return row.name;
    } catch (e) { /* ignore */ }
    return this.COMPANY_TYPE_NAMES[id] || `类型 ${id}`;
  },

  /**
   * 从 API company_detailed 解析公司仓库总容量（storage_space 为全品类合计上限）
   * @returns {{ storageSpace: number, storageSize: string, itemCount: number }}
   */
  resolveStockCapacity(detailed, stockItems) {
    const d = detailed?.company_detailed || detailed || {};
    const upgrades = d.upgrades || {};
    const storageSpace = Number(
      d.storage_space ?? upgrades.storage_space ?? d.storageSpace ?? 0
    ) || 0;
    const storageSize = String(
      d.storage_size ?? upgrades.storage_size ?? d.storageSize ?? ''
    ).trim();
    const itemCount = Math.max(0, (stockItems || []).length);
    return { storageSpace, storageSize, itemCount };
  },

  /**
   * 按销量权重将公司总仓容量分配到各商品（最大余数法，合计不超过 storageSpace）
   * @param {string[]} itemNames
   * @param {number} storageSpace
   * @param {Record<string, number>} weightsByName
   * @returns {Record<string, { target: number, sharePct: number, weight: number }>}
   */
  allocateStockBySales(itemNames, storageSpace, weightsByName) {
    const out = {};
    if (!storageSpace || storageSpace <= 0 || !itemNames?.length) return out;

    const names = itemNames.filter(Boolean);
    const weights = names.map((n) => Math.max(0, Number(weightsByName?.[n]) || 0));
    let totalW = weights.reduce((s, w) => s + w, 0);
    if (totalW <= 0) {
      totalW = names.length;
      for (let i = 0; i < names.length; i++) weights[i] = 1;
    }

    const exacts = weights.map((w) => (storageSpace * w) / totalW);
    const floors = exacts.map((e) => Math.floor(e));
    const fracs = exacts.map((e, i) => ({ i, frac: e - floors[i] }));
    let assigned = floors.reduce((s, n) => s + n, 0);
    let remainder = storageSpace - assigned;
    fracs.sort((a, b) => b.frac - a.frac);
    for (let r = 0; r < remainder; r++) {
      floors[fracs[r % fracs.length].i]++;
    }

    for (let i = 0; i < names.length; i++) {
      const sharePct = totalW > 0 ? (weights[i] / totalW) * 100 : 0;
      out[names[i]] = {
        target: floors[i],
        sharePct,
        weight: weights[i],
      };
    }
    return out;
  },

  /** 交易分类：tax/train/other 为收入，boost 为支出 */
  isTransactionIncome(tx) {
    const cat = (tx?.category || 'other').toLowerCase();
    return cat !== 'boost';
  },

  formatTransactionAmount(tx) {
    const amt = Math.abs(Number(tx?.amount) || 0);
    const income = this.isTransactionIncome(tx);
    const sign = income ? '+' : '−';
    const cls = income ? 'text-torn-green' : 'text-red-400';
    return `<span class="${cls} font-medium">${sign}${this.formatMoney(amt)}</span>`;
  },

  transactionCategoryOptions(selected) {
    const sel = selected || 'other';
    const cats = [
      { value: 'tax', label: '税务' },
      { value: 'train', label: '训练' },
      { value: 'boost', label: 'Boost' },
      { value: 'other', label: '其他' },
    ];
    return cats.map((c) =>
      `<option value="${c.value}" ${sel === c.value ? 'selected' : ''}>${c.label}</option>`
    ).join('');
  },

  /** 建议库存折合的可售天数（需已知当日/近期销量） */
  stockCapDays(targetStock, dailyRate) {
    if (!targetStock || !dailyRate || dailyRate <= 0) return null;
    return targetStock / dailyRate;
  },

  /** Boost 单价：旧数据存的是千美元，迁移为美元 */
  normalizeBoostPrice(stored) {
    const n = Number(stored) || 0;
    if (n > 0 && n < 500) return n * 1000;
    return n;
  },

  // Format percentage
  formatPct(n, decimals = 1) {
    if (n == null) return '-';
    return n.toFixed(decimals) + '%';
  },

  // Unix timestamp to local date string
  formatDate(ts) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  },

  // Unix timestamp to local datetime (accepts seconds or milliseconds)
  formatDateTime(ts) {
    if (!ts) return '-';
    // Normalize: if < 1e11 (year 1973), assume seconds → convert to ms
    if (ts < 100000000000) ts *= 1000;
    return new Date(ts).toLocaleString('zh-CN');
  },

  // Relative time (e.g., "3天前")
  relativeTime(ts) {
    if (!ts) return '-';
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
    return Math.floor(diff / 2592000) + '月前';
  },

  // Days between now and timestamp
  daysSince(ts) {
    if (!ts) return 0;
    return Math.floor((Date.now() / 1000 - ts) / 86400);
  },

  // Get today's date key (YYYY-MM-DD)
  todayKey() {
    return new Date().toISOString().slice(0, 10);
  },

  // 周一 00:00（本地）作为一周起点
  _mondayOfWeek(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    d.setDate(d.getDate() - dow);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  // ISO 8601 周（周一为第一天）；weekKey 格式 YYYY-Wnn
  weekKey(date) {
    const d = date ? new Date(date) : new Date();
    const monday = this._mondayOfWeek(d);
    const thursday = new Date(monday);
    thursday.setDate(monday.getDate() + 3);
    const isoYear = thursday.getFullYear();
    const week1Monday = this._mondayOfWeek(new Date(isoYear, 0, 4));
    const weekNum = Math.round((monday - week1Monday) / 604800000) + 1;
    return isoYear + '-W' + String(weekNum).padStart(2, '0');
  },

  // 由 weekKey 反推周一~周日（与 weekKey 互逆）
  weekDateRange(weekKey) {
    const parts = weekKey.split('-W');
    const year = parseInt(parts[0], 10);
    const weekNum = parseInt(parts[1], 10);
    const week1Monday = this._mondayOfWeek(new Date(year, 0, 4));
    const start = new Date(week1Monday);
    start.setDate(week1Monday.getDate() + (weekNum - 1) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  },

  // 对 weekKey 进行加减操作，返回新的 weekKey
  // delta: 整数，正数=未来周，负数=过去周
  weekKeyAdd(weekKey, delta) {
    const range = this.weekDateRange(weekKey);
    const newDate = new Date(range.start);
    newDate.setDate(newDate.getDate() + delta * 7);
    return this.weekKey(newDate);
  },

  // 日历周起点（周一 00:00），供财务筛选等与 weekKey 对齐
  startOfCalendarWeek(date) {
    return this._mondayOfWeek(date || new Date());
  },

  // 员工本周纳税状态（与财务管理 employee_tax 一致）
  async getEmployeeTaxStatusMap(weekKey) {
    const wk = weekKey || this.weekKey();
    let records = [];
    try {
      records = await DB.getByIndex('employee_tax', 'week_key', wk) || [];
    } catch (e) {
      records = (await DB.getAll('employee_tax') || []).filter(r => r.week_key === wk);
    }
    const map = new Map();
    for (const row of records) {
      const pid = Number(row.player_id);
      if (!pid) continue;
      const taxAmt = Number(row.tax_amount) || 0;
      const paidAmt = Number(row.paid_amount) || 0;
      let status;
      if (row.is_written_off === true) {
        status = 'writeoff';
      } else if (taxAmt > 0 && paidAmt >= taxAmt) {
        status = 'paid';
      } else if (paidAmt <= 0) {
        status = 'unpaid';
      } else {
        status = 'partial';
      }
      map.set(pid, { status, taxAmt, paidAmt });
    }
    return map;
  },

  formatEmployeeTaxStatus(entry) {
    if (!entry) return '<span class="text-gray-500">—</span>';
    const labels = {
      paid: '<span class="badge badge-green">已缴清</span>',
      unpaid: '<span class="badge badge-red">未缴</span>',
      partial: '<span class="badge badge-yellow">欠费</span>',
      writeoff: '<span class="badge badge-gray">已销账</span>'
    };
    return labels[entry.status] || '—';
  },

  // Human-readable week label: "2026年5月11日 - 17日 (第20周)"
  weekLabel(weekKey) {
    const range = this.weekDateRange(weekKey);
    const parts = weekKey.split('-W');
    const weekNum = parseInt(parts[1], 10);
    const year = parseInt(parts[0], 10);
    const startMonth = range.start.getMonth() + 1;
    const startDay = range.start.getDate();
    const endMonth = range.end.getMonth() + 1;
    const endDay = range.end.getDate();
    return year + '年' + startMonth + '月' + startDay + '日 - ' + endDay + '日 (第' + weekNum + '周)';
  },

  // Get count of currently active employees from IndexedDB
  async getEmployeeCount() {
    try {
      const all = await DB.getAll('employees_master');
      if (!all || !all.length) return 0;
      return all.filter(emp => !emp.left_date).length;
    } catch (e) {
      console.error('getEmployeeCount error:', e);
      return 0;
    }
  },

  // Format currency without decimals ($1,234)
  formatCurrency(amount) {
    return '$' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  },

  // Debounce
  debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  },

  // Color for effectiveness value
  effColor(val, max = 100) {
    const pct = val / max;
    if (pct >= 0.8) return '#4ade80';
    if (pct >= 0.5) return '#facc15';
    return '#ef4444';
  },

  // Color for addiction
  addictionColor(val) {
    if (val === '无' || val === '') return '#4ade80';
    const n = Number(val);
    if (!Number.isNaN(n)) {
      if (n >= 0) return '#4ade80';
      if (n >= -5) return '#facc15';
      return '#ef4444';
    }
    if (!val) return '#9ca3af';
    return '#facc15';
  },

  /** 与毒瘾监控页一致：effectiveness.addiction 数值 */
  getEmployeeAddiction(emp) {
    const eff = emp?.effectiveness || {};
    if (eff.addiction !== undefined && eff.addiction !== null) return Number(eff.addiction);
    if (eff.settle_bonus !== undefined && eff.settle_bonus !== null) return Number(eff.settle_bonus);
    return null;
  },

  formatAddictionCell(emp) {
    const val = this.getEmployeeAddiction(emp);
    if (val !== null && !Number.isNaN(val)) {
      const color = this.addictionColor(val);
      return `<span class="font-bold font-mono" style="color:${color}">${val}</span>`;
    }
    const detail = emp?.status?.details;
    if (detail) return `<span class="text-gray-400 text-xs">${detail}</span>`;
    return '<span class="text-gray-500">—</span>';
  },

  dailyXanFromPersonalStats(ps) {
    if (!ps) return null;
    const taken = Number(ps.xantaken ?? ps.xanaxtaken ?? ps.xanax) || 0;
    const days = Number(ps.daysold ?? ps.days_old) || 0;
    if (days > 0) return taken / days;
    const activity = Number(ps.useractivitytime) || 0;
    if (activity > 0) return taken / Math.max(1, activity / 86400);
    return taken > 0 ? taken : null;
  },

  /** 从快照 profile + detailed + 可选库存估算周财务 API 数据 */
  resolveCompanyFinancials(snapshot, stockItems) {
    const profile = snapshot?.profile || {};
    const detailed = snapshot?.detailed || {};
    const weekIncome = Number(profile.weekly_income ?? detailed.weekly_income) || 0;
    const dailyIncome = Number(profile.daily_income ?? detailed.daily_income)
      || (weekIncome > 0 ? weekIncome / 7 : 0);

    let dailyCost = Number(
      detailed.daily_cost_of_goods ?? detailed.daily_cost ?? detailed.cost_of_goods ?? 0
    );
    if (!dailyCost && Array.isArray(stockItems) && stockItems.length) {
      dailyCost = stockItems.reduce((s, it) => {
        return s + (Number(it.sold_amount) || 0) * (Number(it.cost) || 0);
      }, 0);
    }
    if (!dailyCost && detailed.daily_income != null && detailed.daily_profit != null) {
      const wages = Number(detailed.daily_wages) || 0;
      const ad = Number(detailed.advertising_budget) || 0;
      dailyCost = Math.max(0, Number(detailed.daily_income) - Number(detailed.daily_profit) - wages - ad);
    }

    const dailyAd = Number(detailed.advertising_budget ?? detailed.daily_advertising) || 0;
    return {
      weekIncome: weekIncome || dailyIncome * 7,
      weekCost: dailyCost * 7,
      weekAdFee: dailyAd * 7,
      dailyIncome,
      dailyCost,
    };
  },

  /** 按财务 boost 交易同步卖家 points_used / last_purchased_at */
  async reconcileBoostSellersFromTransactions() {
    const sellers = await DB.getAll('boost_sellers') || [];
    const txs = (await DB.getAll('transactions') || []).filter((t) => t.category === 'boost');
    for (const seller of sellers) {
      const pid = String(seller.player_id);
      const sellerTxs = txs.filter((t) => String(t.player_id) === pid);
      seller.points_used = sellerTxs.length * 250;
      if (sellerTxs.length) {
        let latest = 0;
        for (const tx of sellerTxs) {
          let ts = tx.timestamp || 0;
          if (ts > 0 && ts < 1e12) ts *= 1000;
          if (ts > latest) latest = ts;
        }
        if (latest) seller.last_purchased_at = latest;
      }
      await DB.put('boost_sellers', seller);
    }
  },

  // Status color
  statusColor(state) {
    const map = { 'Okay': 'green', 'Hospital': 'red', 'Traveling': 'blue', 'Jail': 'yellow', 'Federal': 'yellow' };
    return map[state] || 'gray';
  },

  // Status dot class
  statusDotClass(lastAction) {
    if (!lastAction) return 'status-offline';
    if (lastAction.status === 'Online') return 'status-online';
    if (lastAction.status === 'Idle') return 'status-idle';
    return 'status-offline';
  },

  // Convert HTML string to DOM element
  htmlToElement(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstChild;
  },

  // Insert Components HTML string into a container
  setHTML(container, html) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (container) container.innerHTML = html;
  },

  // Create element helper - supports both patterns:
  //   el('div', { class: 'foo', text: 'bar' })  - attrs object
  //   el('div', 'foo bar', 'text content')       - className string + optional text
  el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    // Support string shorthand: el('div', 'className', 'text')
    if (typeof attrs === 'string') {
      e.className = attrs;
      if (typeof children === 'string') {
        e.textContent = children;
        children = [];
      }
    } else {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v);
      }
    }
    if (Array.isArray(children)) {
      for (const c of children) {
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      }
    }
    return e;
  },

  // Show toast notification
  toast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) { console.log(`[Toast ${type}]`, message); return; }
    const toast = Utils.el('div', { class: `toast toast-${type}` }, [
      Utils.el('i', { class: `fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}` }),
      Utils.el('span', { text: message })
    ]);
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  // Show/hide loading (safe - won't crash if elements missing)
  showLoading(text = '加载中...') {
    const el = document.getElementById('loading');
    const textEl = document.getElementById('loading-text');
    if (textEl) textEl.textContent = text;
    if (el) { el.classList.remove('hidden'); el.classList.add('flex'); }
  },
  hideLoading() {
    const el = document.getElementById('loading');
    if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
  },

  // Show modal
  showModal(content) {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-content');
    container.innerHTML = '';
    if (typeof content === 'string') container.innerHTML = content;
    else container.appendChild(content);
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  },
  hideModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  },

  // CSV export
  exportCSV(headers, rows, filename) {
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  },

  // Number input with k/m support
  parseMoneyInput(str) {
    if (!str) return 0;
    str = str.trim().toLowerCase();
    if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
    if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000000);
    if (str.endsWith('b')) return Math.round(parseFloat(str) * 1000000000);
    return parseInt(str.replace(/,/g, ''), 10) || 0;
  },

  // 同步员工到 employees_master（幂等：仅新增和更新 last_seen/name/position）
  // 不标记离职 —— 只有 EmployeePage 负责入职/离职逻辑
  // 统一使用 Number 类型作为 player_id，与 EmployeePage 保持一致
  async syncEmployeesMaster(employees) {
    if (!employees || !Array.isArray(employees)) return;
    for (const emp of employees) {
      const playerId = Number(emp.id || emp.player_id);
      if (!playerId) continue;
      try {
        const existing = await DB.get('employees_master', playerId);
        if (!existing) {
          await DB.put('employees_master', {
            player_id: playerId,
            name: emp.name || `ID:${playerId}`,
            position: emp.position?.name || emp.position || 'N/A',
            first_seen: Utils.todayKey(),
            last_seen: Utils.todayKey(),
            left_date: null
          });
        } else {
          // 如果 existing 的 player_id 是字符串类型，修正为 Number
          await DB.put('employees_master', {
            ...existing,
            player_id: playerId,
            name: emp.name || existing.name,
            position: emp.position?.name || emp.position || existing.position,
            last_seen: Utils.todayKey()
            // 保留 left_date（只有 EmployeePage 负责设置）
          });
        }
      } catch (e) {
        // 静默处理（并发冲突等）
      }
    }
  }
};
