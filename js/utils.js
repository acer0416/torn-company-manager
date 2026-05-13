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

  // Get week key (YYYY-Wnn)
  weekKey() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return d.getFullYear() + '-W' + String(week).padStart(2, '0');
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
    if (!val || val >= 0) return '#4ade80';
    if (val >= -5) return '#facc15';
    return '#ef4444';
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
  }
};
