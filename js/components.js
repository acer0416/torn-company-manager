/**
 * components.js - Reusable UI Components
 * Defines window.UI with various reusable component generators
 */

window.UI = {

  /**
   * KPI Card - A metric card with icon, big value, small subtext
   * @param {string} icon - Font Awesome icon class (e.g. 'fas fa-users')
   * @param {string} label - Metric label
   * @param {string|number} value - Main value to display
   * @param {string} subtext - Small descriptive text below value
   * @param {string} colorClass - 'accent'|'gold'|'green'|'blue'|'purple'
   * @returns {string} HTML string
   */
  kpiCard(icon, label, value, subtext, colorClass) {
    const cls = colorClass || 'accent';
    // Auto-prepend 'fas fa-' if only icon name given
    const iconCls = icon.includes('fa-') ? icon : `fas fa-${icon}`;
    return `
      <div class="kpi-card ${cls}">
        <div class="kpi-icon"><i class="${iconCls}"></i></div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value != null ? value : '--'}</div>
        ${subtext ? `<div class="kpi-subtext">${subtext}</div>` : ''}
      </div>
    `;
  },

  /**
   * Data Table - Sortable table with headers and rows
   * @param {Object} opts
   * @param {Array<{key,label,sortable,render}>} opts.headers - Column definitions
   * @param {Array<Object>} opts.rows - Row data objects
   * @param {string} opts.id - Table element id (needed for sort binding)
   * @param {boolean} opts.sortable - Whether table is sortable
   * @param {string} opts.emptyText - Text to show when no rows
   * @returns {string} HTML string
   */
  dataTable({ headers, rows, id, sortable, emptyText }) {
    const tableId = id || 'data-table-' + Date.now();
    const isSortable = sortable !== false;

    if (!rows || rows.length === 0) {
      const text = emptyText || 'No data available';
      return `
        <div class="data-table-wrapper">
          <table class="data-table" id="${tableId}" data-sortable="${isSortable}">
            <thead>
              <tr>
                ${headers.map(h => `<th>${h.label || ''}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="${headers.length}" style="text-align:center; padding:2rem; color:#666;">
                  ${text}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }

    const headerHtml = headers.map(h => {
      const sortableAttr = isSortable && h.sortable !== false ? 'data-sortable="true"' : '';
      const keyAttr = h.key ? `data-key="${h.key}"` : '';
      const sortIndicator = isSortable && h.sortable !== false
        ? ' <span class="sort-indicator"><i class="fas fa-sort"></i></span>'
        : '';
      return `<th ${sortableAttr} ${keyAttr} style="${h.width ? 'width:' + h.width : ''}">${h.label || ''}${sortIndicator}</th>`;
    }).join('');

    const bodyHtml = rows.map(row => {
      const cells = headers.map(h => {
        const rawValue = row[h.key];
        if (h.render) {
          return `<td>${h.render(h.width, rawValue, row)}</td>`;
        }
        return `<td>${rawValue != null ? rawValue : ''}</td>`;
      }).join('');
      return `<tr data-id="${row.id || ''}">${cells}</tr>`;
    }).join('');

    // Store rows data on the table for re-sorting
    const rowsJson = JSON.stringify(rows).replace(/'/g, '&#39;').replace(/</g, '&lt;');

    return `
      <div class="data-table-wrapper">
        <table class="data-table" id="${tableId}" data-sortable="${isSortable}" data-rows='${rowsJson}'>
          <thead>
            <tr>${headerHtml}</tr>
          </thead>
          <tbody>
            ${bodyHtml}
          </tbody>
        </table>
      </div>
    `;
  },

  /**
   * Search Bar - Input with magnifying glass icon
   * @param {string} placeholder - Placeholder text
   * @param {string} id - Input element id
   * @returns {string} HTML string
   */
  searchBar(placeholder, id) {
    const inputId = id || 'search-' + Date.now();
    return `
      <div class="input search-bar-wrapper" style="position:relative;">
        <i class="fas fa-search" style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#666; pointer-events:none;"></i>
        <input type="text" id="${inputId}" class="input" placeholder="${placeholder || 'Search...'}" style="padding-left:32px; width:100%;" />
      </div>
    `;
  },

  /**
   * Tab Navigation - Horizontal tab bar
   * @param {Array<{id,label,icon}>} tabs - Tab definitions
   * @param {string} activeTab - Currently active tab id
   * @param {string} id - Tab nav element id
   * @returns {string} HTML string
   */
  tabNav(tabs, activeTab, id) {
    const navId = id || 'tab-nav-' + Date.now();
    const items = tabs.map(tab => {
      const isActive = tab.id === activeTab ? 'active' : '';
      const iconHtml = tab.icon ? `<i class="${tab.icon}"></i> ` : '';
      return `
        <div class="tab-item ${isActive}" data-tab="${tab.id}">
          ${iconHtml}${tab.label}
        </div>
      `;
    }).join('');

    return `<div class="tab-bar" id="${navId}">${items}</div>`;
  },

  /**
   * Stat Bar - Horizontal progress bar with label
   * @param {string} label - Label text
   * @param {number} value - Current value
   * @param {number} max - Maximum value
   * @param {string} color - Hex color string
   * @param {boolean} showValue - Whether to show value text
   * @returns {string} HTML string
   */
  statBar(label, value, max, color, showValue) {
    const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
    const barColor = color || '#e94560';
    const valueDisplay = showValue !== false ? `<span class="eff-value">${value} / ${max}</span>` : '';

    return `
      <div class="stat-bar-row" style="margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
          <span class="eff-label">${label}</span>
          ${valueDisplay}
        </div>
        <div class="eff-bar">
          <div class="eff-bar-fill" style="width:${pct}%; background:${barColor};"></div>
        </div>
      </div>
    `;
  },

  /**
   * Empty State - Centered icon, message, and optional action button
   * @param {string} icon - Font Awesome icon class
   * @param {string} message - Message to display
   * @param {string} [actionLabel] - Button label (optional)
   * @param {string} [actionId] - Button element id (optional)
   * @returns {string} HTML string
   */
  emptyState(icon, message, actionLabel, actionId) {
    const button = actionLabel
      ? `<button class="btn btn-primary" id="${actionId || 'empty-action'}" style="margin-top:12px;">${actionLabel}</button>`
      : '';
    return `
      <div class="empty-state" style="text-align:center; padding:3rem 1rem; color:#888;">
        <i class="${icon}" style="font-size:2.5rem; margin-bottom:12px; display:block; opacity:0.5;"></i>
        <p style="margin:0;">${message}</p>
        ${button}
      </div>
    `;
  },

  /**
   * Editable Cell - Displays a value, click to edit inline
   * @param {*} value - Current value
   * @param {string} field - Field name for the custom event
   * @param {string|number} recordId - Record identifier
   * @param {string} type - 'text'|'number'|'textarea'
   * @returns {string} HTML string
   */
  editableCell(value, field, recordId, type) {
    const displayValue = value != null ? value : '';
    const escapedValue = String(displayValue).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `
      <span class="editable-cell"
            data-field="${field}"
            data-record-id="${recordId}"
            data-type="${type || 'text'}"
            data-value="${escapedValue}"
            onclick="UI._startEdit(this)"
            style="cursor:pointer; border-bottom:1px dashed #555; padding:2px 4px;">
        ${displayValue}
        <i class="fas fa-pencil-alt" style="font-size:0.7em; opacity:0.4; margin-left:4px;"></i>
      </span>
    `;
  },

  /**
   * Internal: Start editing an editable cell
   * @private
   */
  _startEdit(span) {
    const field = span.dataset.field;
    const recordId = span.dataset.recordId;
    const type = span.dataset.type;
    const currentValue = span.dataset.value;

    // Prevent double-init
    if (span.querySelector('input, textarea')) return;

    let inputHtml;
    if (type === 'textarea') {
      inputHtml = `<textarea class="input input-sm" style="width:100%; min-height:60px;">${currentValue}</textarea>`;
    } else {
      inputHtml = `<input type="${type}" class="input input-sm" value="${currentValue}" style="width:100%;" />`;
    }

    span.innerHTML = inputHtml;
    const input = span.querySelector('input, textarea');
    input.focus();
    if (input.select) input.select();

    const finishEdit = () => {
      const newValue = input.value;
      span.dataset.value = newValue;
      span.innerHTML = `${newValue} <i class="fas fa-pencil-alt" style="font-size:0.7em; opacity:0.4; margin-left:4px;"></i>`;
      // Dispatch custom event
      document.dispatchEvent(new CustomEvent('cell-edited', {
        detail: { field, recordId, value: newValue }
      }));
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && type !== 'textarea') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        span.dataset.value = currentValue;
        span.innerHTML = `${currentValue} <i class="fas fa-pencil-alt" style="font-size:0.7em; opacity:0.4; margin-left:4px;"></i>`;
      }
    });
  },

  /**
   * Pagination - Page navigation buttons
   * @param {number} currentPage - Current page (1-indexed)
   * @param {number} totalPages - Total number of pages
   * @param {string} id - Pagination container id
   * @returns {string} HTML string
   */
  pagination(currentPage, totalPages, id) {
    if (totalPages <= 1) return '';

    const pagId = id || 'pagination-' + Date.now();
    let buttons = '';

    // Previous button
    buttons += `<button class="btn btn-sm btn-secondary" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>
      <i class="fas fa-chevron-left"></i>
    </button>`;

    // Page numbers with ellipsis logic
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
      buttons += `<button class="btn btn-sm btn-secondary" data-page="1">1</button>`;
      if (startPage > 2) buttons += `<span style="padding:0 4px; color:#666;">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
      const active = i === currentPage ? 'btn-primary' : 'btn-secondary';
      buttons += `<button class="btn btn-sm ${active}" data-page="${i}">${i}</button>`;
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) buttons += `<span style="padding:0 4px; color:#666;">...</span>`;
      buttons += `<button class="btn btn-sm btn-secondary" data-page="${totalPages}">${totalPages}</button>`;
    }

    // Next button
    buttons += `<button class="btn btn-sm btn-secondary" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>
      <i class="fas fa-chevron-right"></i>
    </button>`;

    return `<div class="pagination" id="${pagId}" style="display:flex; gap:4px; align-items:center; justify-content:center; padding:8px 0;">${buttons}</div>`;
  },

  /**
   * Format table data - Helper to transform API data into table rows
   * @param {Array} data - Raw data array
   * @param {Array} columns - Column definitions with key and optional transform
   * @returns {Array<Object>} Formatted row objects
   */
  formatTableData(data, columns) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(item => {
      const row = {};
      columns.forEach(col => {
        if (col.transform) {
          row[col.key] = col.transform(item);
        } else if (col.source) {
          // Support nested keys like 'stats.manual_labor'
          const keys = col.source.split('.');
          let val = item;
          for (const k of keys) {
            val = val != null ? val[k] : undefined;
          }
          row[col.key] = val;
        } else {
          row[col.key] = item[col.key];
        }
      });
      // Preserve original id if present
      if (item.id != null) row.id = item.id;
      if (item.ID != null) row.id = row.id || item.ID;
      return row;
    });
  },

  /**
   * Initialize sortable table - Attach click handlers to sortable headers
   * @param {string} tableId - The table element id
   */
  initSortable(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;

    const headers = table.querySelectorAll('th[data-sortable="true"]');
    const tbody = table.querySelector('tbody');

    // Parse stored rows data
    let allRows;
    try {
      allRows = JSON.parse(table.dataset.rows || '[]');
    } catch (e) {
      allRows = [];
    }

    // Track sort state
    if (!table._sortState) {
      table._sortState = { key: null, direction: 'asc' };
    }

    headers.forEach(th => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';

      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (!key) return;

        // Toggle direction
        if (table._sortState.key === key) {
          table._sortState.direction = table._sortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
          table._sortState.key = key;
          table._sortState.direction = 'asc';
        }

        const { direction } = table._sortState;

        // Sort rows
        const sorted = [...allRows].sort((a, b) => {
          let valA = a[key];
          let valB = b[key];

          // Handle null/undefined
          if (valA == null) valA = '';
          if (valB == null) valB = '';

          // Try numeric comparison
          const numA = parseFloat(String(valA).replace(/[^0-9.-]/g, ''));
          const numB = parseFloat(String(valB).replace(/[^0-9.-]/g, ''));

          if (!isNaN(numA) && !isNaN(numB)) {
            return direction === 'asc' ? numA - numB : numB - numA;
          }

          // String comparison
          const strA = String(valA).toLowerCase();
          const strB = String(valB).toLowerCase();
          if (direction === 'asc') return strA.localeCompare(strB);
          return strB.localeCompare(strA);
        });

        // Re-render tbody
        // We need to re-render using the original header render functions
        // Since we can't store functions in data attributes, we re-read from the current header setup
        // Instead, we'll just reorder the existing rows in the tbody
        const rowsMap = {};
        tbody.querySelectorAll('tr').forEach(tr => {
          const id = tr.dataset.id;
          if (id) rowsMap[id] = tr;
        });

        // Clear and re-append in sorted order
        const fragment = document.createDocumentFragment();
        sorted.forEach(row => {
          const tr = rowsMap[row.id];
          if (tr) {
            fragment.appendChild(tr);
          }
        });
        tbody.innerHTML = '';
        tbody.appendChild(fragment);

        // Update sort indicators
        headers.forEach(h => {
          const indicator = h.querySelector('.sort-indicator i');
          if (indicator) {
            if (h.dataset.key === key) {
              indicator.className = direction === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
            } else {
              indicator.className = 'fas fa-sort';
            }
          }
        });
      });
    });
  }
};
