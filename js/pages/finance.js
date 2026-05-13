// Finance Page - Transactions, Tax, Fund Flow
// Uses innerHTML pattern with Components (return HTML strings)
window.FinancePage = {
    activeTab: 'overview',
    transactions: [],
    employees: [],
    config: { weekly_tax_amount: 0 },
    latestSnapshot: null,

    // Filters for transactions tab
    txFilterEmp: '',
    txFilterTime: 'week',

    // State for auto-detect modal
    adLogs: [],
    adFilterEmp: '',
    adFilterTime: 'week',
    itemNameCache: {},  // item ID -> name lookup

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载财务数据...');
        try {
            await this._loadData();
            Utils.hideLoading();
            c.innerHTML = this._buildHTML();
            this._bindEvents();
        } catch (e) {
            Utils.hideLoading();
            c.innerHTML = `
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">
                        <i class="fas fa-wallet mr-2 text-torn-accent"></i>财务管理
                    </h2>
                </div>
                <div class="text-red-400 p-4">Error: ${e.message}</div>
            `;
        }
    },

    async _loadData() {
        // Load tax config
        const taxAmt = await DB.get('training_config', 'weekly_tax_amount');
        this.config.weekly_tax_amount = taxAmt?.value ?? 0;

        // Load all transactions
        this.transactions = (await DB.getAll('transactions')) || [];

        // Load employees from employees_master DB
        try {
            const masterEmployees = await DB.getAll('employees_master');
            if (masterEmployees && masterEmployees.length) {
                this.employees = masterEmployees;
                return;
            }
        } catch (e) { /* fallback */ }

        // Fallback: fetch from API
        try {
            const data = await TornAPI.getCompanyEmployees();
            this.employees = Object.entries(data.employees || data).map(([id, e]) => ({
                player_id: String(id),
                name: e.name || `ID:${id}`,
                position: e.position?.name || e.position || 'N/A',
                ...e
            }));
        } catch (e) {
            this.employees = [];
        }

        // Load latest snapshot for API data
        try {
            const snapshots = await DB.getAll('snapshots');
            if (snapshots && snapshots.length) {
                // sort by timestamp descending
                snapshots.sort((a, b) => b.timestamp - a.timestamp);
                this.latestSnapshot = snapshots[0];
            }
        } catch (e) {
            this.latestSnapshot = null;
        }
    },

    // ---- Full Page HTML ----

    _buildHTML() {
        const headerHTML = `
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-white">
                    <i class="fas fa-wallet mr-2 text-torn-accent"></i>财务管理
                </h2>
                <div class="flex gap-2">
                    <button class="btn btn-primary" data-action="add-transaction">
                        <i class="fas fa-plus"></i> 添加交易
                    </button>
                    <button class="btn btn-secondary" data-action="refresh">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>
        `;

        const tabsHTML = UI.tabNav([
            { id: 'overview', label: '财务概览', icon: 'fas fa-chart-pie' },
            { id: 'transactions', label: '交易记录', icon: 'fas fa-exchange-alt' },
            { id: 'tax', label: '税务管理', icon: 'fas fa-file-invoice-dollar' }
        ], this.activeTab, 'finance-tabs');

        let tabContent = '';
        switch (this.activeTab) {
            case 'overview':     tabContent = this._overviewTabHTML(); break;
            case 'transactions': tabContent = this._transactionsTabHTML(); break;
            case 'tax':          tabContent = this._taxTabHTML(); break;
        }

        return `${headerHTML}${tabsHTML}<div id="finance-tab-content">${tabContent}</div>`;
    },

    // ---- Tab: 财务概览 ----

    _overviewTabHTML() {
        const now = new Date();
        const dayOfWeek = now.getDay() || 7; // 1-7 (Mon-Sun)
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - dayOfWeek + 1);
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Calculate transaction sums
        let weekTax = 0, weekTrain = 0, weekBoost = 0, weekOther = 0;
        let monthTax = 0, monthTrain = 0, monthBoost = 0, monthOther = 0;

        for (const tx of this.transactions) {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000; // normalize seconds to ms

            if (ts >= startOfWeek.getTime()) {
                if (tx.category === 'tax') weekTax += tx.amount;
                else if (tx.category === 'train') weekTrain += tx.amount;
                else if (tx.category === 'boost') weekBoost += tx.amount;
                else weekOther += tx.amount;
            }
            if (ts >= startOfMonth.getTime()) {
                if (tx.category === 'tax') monthTax += tx.amount;
                else if (tx.category === 'train') monthTrain += tx.amount;
                else if (tx.category === 'boost') monthBoost += tx.amount;
                else monthOther += tx.amount;
            }
        }

        // Get API data from snapshot
        const detailed = this.latestSnapshot?.detailed || {};
        const dailyIncome = detailed.daily_income || 0;
        const dailyAdFee = detailed.advertising_budget || 0;
        
        let dailyCost = detailed.daily_cost_of_goods || 0;
        if (!dailyCost && detailed.daily_income && detailed.daily_profit) {
            const wages = detailed.daily_wages || 0;
            dailyCost = Math.max(0, detailed.daily_income - detailed.daily_profit - dailyAdFee - wages);
        }

        // Calculate Weekly
        const weekIncomeAPI = dailyIncome * 7;
        const weekAdFeeAPI = dailyAdFee * 7;
        const weekCostAPI = dailyCost * 7;
        
        const weekTotalIncome = weekTax + weekTrain + weekOther + weekIncomeAPI;
        const weekTotalExpense = weekBoost + weekCostAPI + weekAdFeeAPI;
        const weekNetProfit = weekTotalIncome - weekTotalExpense;

        // Calculate Monthly (当月已发生的数据 + 本周的预测数据)
        const monthTotalIncome = monthTax + monthTrain + monthOther + weekIncomeAPI;
        const monthTotalExpense = monthBoost + weekCostAPI + weekAdFeeAPI;
        const monthNetProfit = monthTotalIncome - monthTotalExpense;

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-week mr-2 text-torn-accent"></i>本周概览 (日历周预估)
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    ${UI.kpiCard('fas fa-arrow-down', '总支出', Utils.formatMoney(weekTotalExpense), '成本+广告+Boost', 'red')}
                    ${UI.kpiCard('fas fa-arrow-up', '总收入', Utils.formatMoney(weekTotalIncome), '税费+训练+其他+日收入', 'green')}
                    ${UI.kpiCard('fas fa-balance-scale', '净利润', Utils.formatMoney(weekNetProfit), '收入 - 支出', weekNetProfit >= 0 ? 'accent' : 'red')}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- Expenses -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-red-400 border-b border-torn-border pb-2 mb-3">本周支出明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span>商品成本预估 (API计算):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekCostAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>广告费预估 (API):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekAdFeeAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>购买 Boost 记录 (手动/日志):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekBoost)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Income -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-torn-green border-b border-torn-border pb-2 mb-3">本周收入明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span>员工税费 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTax)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>员工训练费 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTrain)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>其他收入 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekOther)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>公司日收入预估 (API):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekIncomeAPI)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Monthly Overview -->
            <div class="card">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-alt mr-2 text-torn-accent"></i>月度概览 (日历月预估)
                </h3>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度总支出预估</div>
                        <div class="text-red-400 font-bold">${Utils.formatMoney(monthTotalExpense)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度总收入预估</div>
                        <div class="text-torn-green font-bold">${Utils.formatMoney(monthTotalIncome)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度净利润预估</div>
                        <div class="${monthNetProfit >= 0 ? 'text-torn-gold' : 'text-red-400'} font-bold">${Utils.formatMoney(monthNetProfit)}</div>
                    </div>
                </div>
                <div class="text-xs text-gray-500 text-right">计算公式：当月实际交易记录 + 本周API预测数据</div>
            </div>
        `;
    },

    // ---- Tab: 交易记录 ----

    _transactionsTabHTML() {
        const empOptions = this.employees.map(e => `<option value="${e.player_id}" ${this.txFilterEmp === String(e.player_id) ? 'selected' : ''}>${e.name}</option>`).join('');

        const headers = [
            { key: 'select', label: '<input type="checkbox" id="tx-select-all" class="cursor-pointer" />', sortable: false },
            { key: 'date', label: '日期', sortable: true },
            { key: 'employee', label: '员工', sortable: true },
            { key: 'amount', label: '金额', sortable: true },
            { key: 'category', label: '分类' },
            { key: 'note', label: '备注' },
            { key: 'actions', label: '操作', sortable: false }
        ];

        let filteredTx = this.transactions;
        if (this.txFilterEmp) {
            filteredTx = filteredTx.filter(t => String(t.player_id) === this.txFilterEmp);
        }

        const now = new Date();
        if (this.txFilterTime === 'week') {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - (now.getDay() || 7) + 1);
            startOfWeek.setHours(0, 0, 0, 0);
            filteredTx = filteredTx.filter(t => {
                let ts = t.timestamp || 0;
                if (ts > 0 && ts < 100000000000) ts *= 1000;
                return ts >= startOfWeek.getTime();
            });
        } else if (this.txFilterTime === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            filteredTx = filteredTx.filter(t => {
                let ts = t.timestamp || 0;
                if (ts > 0 && ts < 100000000000) ts *= 1000;
                return ts >= startOfMonth.getTime();
            });
        }

        const sortedTx = [...filteredTx].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const rows = sortedTx.map(tx => {
            const cat = tx.category || 'other';
            const catSelect = `
                <select class="input input-xs bg-torn-surface border border-torn-border cursor-pointer tx-cat-select max-w-[80px]" data-tx-id="${tx.id}">
                    <option value="train" ${cat === 'train' ? 'selected' : ''}>训练</option>
                    <option value="tax" ${cat === 'tax' ? 'selected' : ''}>税务</option>
                    <option value="other" ${cat === 'other' ? 'selected' : ''}>其他</option>
                </select>
            `;
            return {
                select: `<input type="checkbox" class="tx-row-cb cursor-pointer" data-tx-id="${tx.id}" />`,
                id: tx.id,
                date: tx.date || '-',
                employee: tx.player_name || '-',
                amount: Utils.formatMoney(tx.amount || 0),
                category: catSelect,
                note: tx.note || '-',
                actions: `
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-secondary" data-action="edit-tx" data-tx-id="${tx.id}" title="编辑">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-xs btn-secondary" data-action="split-tx" data-tx-id="${tx.id}" title="拆分">
                            <i class="fas fa-cut"></i>
                        </button>
                        <button class="btn btn-xs btn-secondary" data-action="delete-tx" data-tx-id="${tx.id}" title="删除">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `
            };
        });

        return `
            <div class="card">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-white mb-3">
                        <i class="fas fa-exchange-alt mr-2 text-torn-accent"></i>交易记录
                    </h3>
                    <div class="flex items-center gap-2 overflow-x-auto pb-1 hide-scrollbar">
                        <select id="tx-filter-time" class="input input-sm shrink-0 truncate" style="max-width: 90px;">
                            <option value="week" ${this.txFilterTime === 'week' ? 'selected' : ''}>本周</option>
                            <option value="month" ${this.txFilterTime === 'month' ? 'selected' : ''}>本月</option>
                            <option value="all" ${this.txFilterTime === 'all' ? 'selected' : ''}>全部时间</option>
                        </select>
                        <select id="tx-filter-emp" class="input input-sm shrink-0 truncate" style="max-width: 120px;">
                            <option value="">全部员工</option>
                            ${empOptions}
                        </select>
                        <button class="btn btn-sm btn-secondary whitespace-nowrap shrink-0" data-action="auto-detect">
                            <i class="fas fa-search"></i> 自动检测
                        </button>
                        <button class="btn btn-sm btn-secondary whitespace-nowrap shrink-0" data-action="bulk-edit-category">
                            <i class="fas fa-tag"></i> 批量分类
                        </button>
                        <button class="btn btn-sm bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 whitespace-nowrap shrink-0" data-action="bulk-delete-tx">
                            <i class="fas fa-trash"></i> 批量删除
                        </button>
                    </div>
                </div>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'transactions-table',
                    emptyText: '暂无符合条件的交易记录'
                })}
            </div>
        `;
    },

    // ---- Tab: 税务管理 ----

    _taxTabHTML() {
        const weeklyTax = this.config.weekly_tax_amount || 0;
        const taxTx = this.transactions.filter(t => t.category === 'tax');

        const headers = [
            { key: 'name', label: '姓名', sortable: true },
            { key: 'position', label: '职位', sortable: true },
            { key: 'expected', label: '应缴税款', sortable: true },
            { key: 'paid', label: '已缴金额', sortable: true },
            { key: 'balance', label: '余额(差额)', sortable: true }
        ];

        const rows = this.employees.map(emp => {
            const empTx = taxTx.filter(t => String(t.player_id) === String(emp.player_id));
            const paid = empTx.reduce((s, t) => s + (t.amount || 0), 0);
            const balance = weeklyTax - paid;
            const balColor = balance > 0 ? 'text-red-400' : balance < 0 ? 'text-torn-green' : 'text-gray-300';

            return {
                id: emp.player_id,
                name: emp.name || '-',
                position: emp.position || '-',
                expected: Utils.formatMoney(weeklyTax),
                paid: Utils.formatMoney(paid),
                balance: `<span class="${balColor}">${Utils.formatMoney(balance)}</span>`
            };
        });

        return `
            <div class="card">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-file-invoice-dollar mr-2 text-torn-accent"></i>税务管理
                </h3>
                <div class="flex items-end gap-4 mb-6">
                    <div class="flex-1 max-w-xs">
                        <label class="text-gray-400 text-sm mb-1 block">每周应缴税款 ($)</label>
                        <input type="text" class="input money-input" id="cfg-weekly-tax" value="${weeklyTax}" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <button class="btn btn-primary" data-action="save-tax-config">
                        <i class="fas fa-save"></i> 保存
                    </button>
                </div>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'tax-table',
                    emptyText: '暂无员工数据'
                })}
            </div>
        `;
    },

    // ---- Event Binding ----

    _bindEvents() {
        const c = document.getElementById('page-content');
        if (!c) return;

        // Delegated Change Events
        if (this._changeHandler) c.removeEventListener('change', this._changeHandler);
        this._changeHandler = async (e) => {
            if (e.target.id === 'tx-filter-emp') {
                this.txFilterEmp = e.target.value;
                this.render();
            } else if (e.target.id === 'tx-filter-time') {
                this.txFilterTime = e.target.value;
                this.render();
            } else if (e.target.id === 'tx-select-all') {
                const checkboxes = c.querySelectorAll('.tx-row-cb');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
            } else if (e.target.classList.contains('tx-cat-select')) {
                const txId = Number(e.target.dataset.txId);
                const tx = this.transactions.find(t => t.id === txId);
                if (tx) {
                    tx.category = e.target.value;
                    await DB.put('transactions', tx);
                    Utils.toast('分类已更新', 'success');
                }
            }
        };
        c.addEventListener('change', this._changeHandler);

        // Remove old listeners to prevent stacking
        if (this._clickHandler) c.removeEventListener('click', this._clickHandler);

        this._clickHandler = async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            e.preventDefault();

            const action = btn.dataset.action;
            switch (action) {
                case 'refresh':
                    await this.render();
                    break;
                case 'add-transaction':
                    this._showAddTransactionModal();
                    break;
                case 'save-tax-config':
                    await this._saveTaxConfig();
                    break;
                case 'auto-detect':
                    await this._autoDetect();
                    break;
                case 'edit-tx':
                    this._showEditModal(Number(btn.dataset.txId));
                    break;
                case 'split-tx':
                    this._showSplitModal(Number(btn.dataset.txId));
                    break;
                case 'delete-tx':
                    await this._deleteTx(Number(btn.dataset.txId));
                    break;
                case 'bulk-edit-category':
                    await this._bulkEditCategory();
                    break;
                case 'bulk-delete-tx':
                    await this._bulkDeleteTx();
                    break;
            }
        };
        c.addEventListener('click', this._clickHandler);

        // Tab switching via tabNav (uses data-tab attribute)
        if (this._tabHandler) c.removeEventListener('click', this._tabHandler);
        this._tabHandler = (e) => {
            const tabItem = e.target.closest('.tab-item[data-tab]');
            if (!tabItem) return;
            this.activeTab = tabItem.dataset.tab;
            this.render();
        };
        c.addEventListener('click', this._tabHandler);

        // Init sortable tables
        UI.initSortable('transactions-table');
        UI.initSortable('tax-table');
    },

    // ---- Actions ----

    async _saveTaxConfig() {
        const amount = Utils.parseMoneyInput(document.getElementById('cfg-weekly-tax')?.value);
        this.config.weekly_tax_amount = amount;
        await DB.put('training_config', { key: 'weekly_tax_amount', value: amount });
        Utils.toast('税务配置已保存', 'success');
    },

    async _deleteTx(txId) {
        if (!confirm('确定删除此交易？')) return;
        await DB.delete('transactions', txId);
        Utils.toast('交易已删除', 'info');
        await this.render();
    },

    async _bulkDeleteTx() {
        const checkboxes = document.querySelectorAll('.tx-row-cb:checked');
        if (!checkboxes.length) {
            Utils.toast('请先选中要删除的记录', 'warning');
            return;
        }
        if (!confirm(`确定要删除选中的 ${checkboxes.length} 条记录吗？`)) return;
        
        for (const cb of checkboxes) {
            const txId = Number(cb.dataset.txId);
            await DB.delete('transactions', txId);
        }
        Utils.toast(`已成功删除 ${checkboxes.length} 条记录`, 'success');
        await this.render();
    },

    async _bulkEditCategory() {
        const checkboxes = document.querySelectorAll('.tx-row-cb:checked');
        if (!checkboxes.length) {
            Utils.toast('请先选中要修改分类的记录', 'warning');
            return;
        }

        const count = checkboxes.length;
        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">批量修改分类</h3>
                <div class="text-gray-400 text-sm mb-4">已选中 <span class="text-torn-accent font-bold">${count}</span> 条记录</div>
                <div class="mb-6">
                    <label class="text-gray-400 text-sm mb-1 block">目标分类</label>
                    <select class="input" id="bulk-edit-cat">
                        <option value="train">训练 (train)</option>
                        <option value="tax">税务 (tax)</option>
                        <option value="other">其他 (other)</option>
                    </select>
                </div>
                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="bulk-edit-cancel">取消</button>
                    <button class="btn btn-primary" id="bulk-edit-save">确认修改</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('bulk-edit-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('bulk-edit-save')?.addEventListener('click', async () => {
            const newCat = document.getElementById('bulk-edit-cat')?.value || 'other';
            const taxAmount = this.config.weekly_tax_amount || 0;

            // When targeting 'tax' with a configured tax amount, detect over-amount items
            if (newCat === 'tax' && taxAmount > 0) {
                const allSelected = [];
                for (const cb of checkboxes) {
                    const txId = Number(cb.dataset.txId);
                    const tx = this.transactions.find(t => t.id === txId);
                    if (tx) allSelected.push(tx);
                }

                const overTaxItems = allSelected.filter(tx => tx.amount > taxAmount);
                const directTaxItems = allSelected.filter(tx => tx.amount <= taxAmount);

                if (overTaxItems.length > 0) {
                    Utils.hideModal();
                    this._showBulkTaxSplitModal(overTaxItems, directTaxItems, taxAmount);
                    return;
                }
            }

            // Default: directly set category for all
            let updated = 0;
            for (const cb of checkboxes) {
                const txId = Number(cb.dataset.txId);
                const tx = this.transactions.find(t => t.id === txId);
                if (tx) {
                    tx.category = newCat;
                    await DB.put('transactions', tx);
                    updated++;
                }
            }
            Utils.toast(`已成功修改 ${updated} 条记录的分类`, 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showBulkTaxSplitModal(overTaxItems, directTaxItems, taxAmount) {
        // Build rows: one per over-tax item
        const rowHTML = overTaxItems.map(tx => {
            const remaining = tx.amount - taxAmount;
            return `
                <div class="flex items-center gap-3 p-3 bg-torn-surface border border-torn-border rounded">
                    <input type="checkbox" class="split-tax-cb" data-tx-id="${tx.id}" checked />
                    <div class="flex-1 min-w-0">
                        <div class="text-white text-sm truncate">${tx.player_name || 'N/A'}</div>
                        <div class="text-gray-500 text-xs">原金额: ${Utils.formatMoney(tx.amount)}</div>
                    </div>
                    <div class="text-sm text-gray-400 whitespace-nowrap">
                        税务: <span class="text-torn-gold font-mono">${Utils.formatMoney(taxAmount)}</span>
                    </div>
                    <div class="text-sm whitespace-nowrap">
                        剩余: <span class="text-torn-green font-mono">${Utils.formatMoney(remaining)}</span>
                    </div>
                    <select class="input input-xs bg-torn-surface border border-torn-border split-remainder-cat" style="max-width:100px">
                        <option value="train">train</option>
                        <option value="other">other</option>
                    </select>
                    <input type="hidden" class="split-remainder-amount" value="${remaining}" />
                </div>
            `;
        }).join('');

        const directCount = directTaxItems.length;
        const directNote = directCount > 0
            ? `<div class="text-gray-400 text-sm mb-2">另有 <span class="text-torn-accent">${directCount}</span> 条金额 ≤ 税款的记录将直接设为"税务"</div>`
            : '';

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-2">智能拆分建议</h3>
                <div class="text-gray-400 text-sm mb-4">
                    以下 <span class="text-torn-accent font-bold">${overTaxItems.length}</span> 条记录金额超过周税设置 (${Utils.formatMoney(taxAmount)})，建议拆分为税务 + 其他分类
                </div>
                ${directNote}
                <div class="text-xs text-gray-500 mb-3">取消勾选的记录将直接设为"税务"分类（不拆分）</div>

                <div class="space-y-2 max-h-60 overflow-y-auto mb-4" id="split-tax-list">
                    ${rowHTML}
                </div>

                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="split-tax-cancel">取消</button>
                    <button class="btn btn-primary" id="split-tax-confirm">确认拆分</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('split-tax-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('split-tax-confirm')?.addEventListener('click', async () => {
            let splitCount = 0;
            let directCount = 0;

            for (const tx of overTaxItems) {
                const cb = document.querySelector(`.split-tax-cb[data-tx-id="${tx.id}"]`);
                if (cb && cb.checked) {
                    // Split: delete original, create tax + remainder records
                    const row = cb.closest('.flex.items-center.gap-3');
                    const remainingCat = row?.querySelector('.split-remainder-cat')?.value || 'train';
                    const remaining = tx.amount - taxAmount;

                    await DB.delete('transactions', tx.id);

                    await DB.put('transactions', {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: Date.now(),
                        amount: taxAmount,
                        category: 'tax',
                        note: (tx.note ? tx.note + ' | ' : '') + `批量拆分: 税务部分 (原ID:${tx.id})`,
                        split_from: tx.id
                    });

                    await DB.put('transactions', {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: Date.now(),
                        amount: remaining,
                        category: remainingCat,
                        note: (tx.note ? tx.note + ' | ' : '') + `批量拆分: 剩余部分 (原ID:${tx.id})`,
                        split_from: tx.id
                    });

                    splitCount++;
                } else {
                    // Not split: directly set to tax
                    tx.category = 'tax';
                    await DB.put('transactions', tx);
                    directCount++;
                }
            }

            // Process directTaxItems (amount <= taxAmount)
            for (const tx of directTaxItems) {
                tx.category = 'tax';
                await DB.put('transactions', tx);
                directCount++;
            }

            Utils.toast(`已拆分 ${splitCount} 条, 直接设税 ${directCount} 条`, 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    // ---- Modals ----

    _showAddTransactionModal() {
        const empOptions = this.employees.map(e =>
            `<option value="${e.player_id}">${e.name}</option>`
        ).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">添加交易</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">员工</label>
                        <select class="input" id="modal-tx-emp">
                            <option value="">-- 选择员工 --</option>
                            ${empOptions}
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">金额 ($)</label>
                        <input type="text" class="input money-input" id="modal-tx-amount" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-tx-cat">
                            <option value="train">训练 (train)</option>
                            <option value="tax">税务 (tax)</option>
                            <option value="other">其他 (other)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">备注</label>
                        <textarea class="input" id="modal-tx-note" rows="2"></textarea>
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="modal-tx-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-tx-save">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-tx-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('modal-tx-save')?.addEventListener('click', async () => {
            const empId = document.getElementById('modal-tx-emp')?.value;
            const emp = this.employees.find(e => String(e.player_id) === String(empId));
            const tx = {
                player_id: empId,
                player_name: emp?.name || '',
                date: Utils.todayKey(),
                timestamp: Date.now(),
                amount: Utils.parseMoneyInput(document.getElementById('modal-tx-amount')?.value),
                category: document.getElementById('modal-tx-cat')?.value || 'other',
                note: document.getElementById('modal-tx-note')?.value || ''
            };
            await DB.put('transactions', tx);
            Utils.toast('交易已保存', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showEditModal(txId) {
        const tx = this.transactions.find(t => String(t.id) === String(txId));
        if (!tx) return;

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">编辑交易</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">金额 ($)</label>
                        <input type="text" class="input money-input" id="modal-edit-amount" value="${tx.amount || 0}" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-edit-cat">
                            <option value="train" ${tx.category === 'train' ? 'selected' : ''}>训练 (train)</option>
                            <option value="tax" ${tx.category === 'tax' ? 'selected' : ''}>税务 (tax)</option>
                            <option value="other" ${tx.category === 'other' ? 'selected' : ''}>其他 (other)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">备注</label>
                        <textarea class="input" id="modal-edit-note" rows="2">${tx.note || ''}</textarea>
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="modal-edit-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-edit-save">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-edit-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('modal-edit-save')?.addEventListener('click', async () => {
            tx.amount = Utils.parseMoneyInput(document.getElementById('modal-edit-amount')?.value);
            tx.category = document.getElementById('modal-edit-cat')?.value || 'other';
            tx.note = document.getElementById('modal-edit-note')?.value || '';
            await DB.put('transactions', tx);
            Utils.toast('交易已更新', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showSplitModal(txId) {
        const tx = this.transactions.find(t => String(t.id) === String(txId));
        if (!tx) return;

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-2">拆分交易</h3>
                <div class="text-gray-400 text-sm mb-4">原始: ${Utils.formatMoney(tx.amount)} - ${tx.player_name || 'N/A'}</div>
                <div id="split-parts" class="space-y-3 mb-4">
                    ${this._splitPartHTML(1)}
                    ${this._splitPartHTML(2)}
                </div>
                <div class="text-sm font-bold text-torn-accent mb-4" id="split-remainder">
                    剩余待分配金额: ${Utils.formatMoney(tx.amount)}
                </div>
                <button class="btn btn-xs btn-secondary mb-4" data-action="add-split-part">+ 添加部分</button>
                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="modal-split-cancel">取消</button>
                    <button class="btn btn-primary" id="modal-split-save">拆分</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-split-cancel')?.addEventListener('click', () => Utils.hideModal());

        // Add split part
        const modalContent = document.getElementById('modal-content');
        modalContent?.querySelector('[data-action="add-split-part"]')?.addEventListener('click', () => {
            const parts = document.getElementById('split-parts');
            if (!parts) return;
            const count = parts.querySelectorAll('.split-amount').length + 1;
            parts.insertAdjacentHTML('beforeend', this._splitPartHTML(count));
        });

        // Add input listener for remainder calculation
        document.getElementById('split-parts')?.addEventListener('input', (e) => {
            if (e.target.classList.contains('split-amount')) {
                const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
                const total = amounts.reduce((s, a) => s + a, 0);
                const remainder = tx.amount - total;
                const remEl = document.getElementById('split-remainder');
                if (remEl) {
                    const color = remainder < 0 ? 'text-red-500' : 'text-torn-green';
                    remEl.innerHTML = `剩余待分配金额: <span class="${color}">${Utils.formatMoney(remainder)}</span>`;
                }
            }
        });

        // Add click listener for fill remainder buttons
        document.getElementById('split-parts')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('split-fill-rem')) {
                e.preventDefault();
                const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
                const total = amounts.reduce((s, a) => s + a, 0);
                const remainder = tx.amount - total;
                if (remainder > 0) {
                    const input = e.target.closest('.flex-1').querySelector('.split-amount');
                    if (input) {
                        const curVal = Utils.parseMoneyInput(input.value);
                        input.value = Utils.formatMoney(curVal + remainder).replace('$', '');
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            }
        });

        // Save split
        document.getElementById('modal-split-save')?.addEventListener('click', async () => {
            const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
            const cats = [...document.querySelectorAll('.split-cat')].map(el => el.value);
            const notes = [...document.querySelectorAll('.split-note')].map(el => el.value);

            const total = amounts.reduce((s, a) => s + a, 0);
            if (total > tx.amount + 1) {
                Utils.toast('拆分金额超过原始金额', 'error');
                return;
            }
            if (total < tx.amount) {
                Utils.toast('拆分不完整，存在未分配的余额', 'error');
                return;
            }

            // Delete original
            await DB.delete('transactions', tx.id);

            // Add split parts
            for (let i = 0; i < amounts.length; i++) {
                if (amounts[i] > 0) {
                    await DB.put('transactions', {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: Date.now(),
                        amount: amounts[i],
                        category: cats[i] || 'other',
                        note: notes[i] || `拆分自 ${Utils.formatDateTime(tx.timestamp)} (${Utils.formatMoney(tx.amount)})`,
                        split_from: tx.id
                    });
                }
            }

            Utils.toast('交易已拆分', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _splitPartHTML(index, amount = '') {
        return `
            <div class="flex gap-2 items-end">
                <div class="flex-1">
                    <div class="flex justify-between items-center mb-1">
                        <label class="text-gray-400 text-xs block">部分${index} 金额</label>
                        <a href="#" class="text-torn-accent text-xs hover:underline split-fill-rem" tabindex="-1">填入余额</a>
                    </div>
                    <input type="text" class="input input-sm split-amount money-input" placeholder="支持 k/m/b" value="${amount}" />
                </div>
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">分类</label>
                    <select class="input input-sm split-cat">
                        <option value="train">train</option>
                        <option value="tax">tax</option>
                        <option value="other">other</option>
                    </select>
                </div>
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">备注</label>
                    <input type="text" class="input input-sm split-note" />
                </div>
            </div>
        `;
    },

    _parseItemsFromData(d) {
        const results = [];
        const cache = this.itemNameCache || {};

        const itemEntries = [];
        if (Array.isArray(d.item)) itemEntries.push(...d.item);
        if (Array.isArray(d.items)) itemEntries.push(...d.items);

        for (const it of itemEntries) {
            const entry = cache[it.id];
            const name = entry ? entry.name : `物品#${it.id}`;
            const qty = it.qty || it.quantity || 1;
            results.push(qty > 1 ? `${name} x${qty}` : name);
        }

        if (typeof d.item === 'number') {
            const entry = cache[d.item];
            const name = entry ? entry.name : `物品#${d.item}`;
            const qty = d.quantity || 1;
            results.push(qty > 1 ? `${name} x${qty}` : name);
        }

        return results;
    },

    // Calculate total monetary value of items in log data
    _calculateItemsValue(d) {
        let total = 0;
        const cache = this.itemNameCache || {};

        const itemEntries = [];
        if (Array.isArray(d.item)) itemEntries.push(...d.item);
        if (Array.isArray(d.items)) itemEntries.push(...d.items);

        for (const it of itemEntries) {
            const entry = cache[it.id];
            if (entry && entry.value) {
                const qty = it.qty || it.quantity || 1;
                total += entry.value * qty;
            }
        }

        if (typeof d.item === 'number') {
            const entry = cache[d.item];
            if (entry && entry.value) {
                const qty = d.quantity || 1;
                total += entry.value * qty;
            }
        }

        return total;
    },

    _calculateItemsValueFromList(items) {
        let total = 0;
        const cache = this.itemNameCache || {};
        for (const it of items) {
            const entry = cache[it.id];
            if (entry && entry.value) {
                total += entry.value * (it.qty || 1);
            }
        }
        return total;
    },

    // Fetch and cache all Torn item names (id -> name)
    // Loads from bundled static file first, only calls API for missing IDs
    async _loadItemNames() {
        if (Object.keys(this.itemNameCache).length > 0) return;
        try {
            // Load bundled static item names
            const url = chrome.runtime.getURL('data/item_names.json');
            const resp = await fetch(url);
            const data = await resp.json();
            this.itemNameCache = data;
            console.log(`[FinancePage] Loaded ${Object.keys(this.itemNameCache).length} item names from static file`);
        } catch (e) {
            console.warn('[FinancePage] Failed to load static item names, falling back to API:', e);
            try {
                const data = await TornAPI.v1('items', 'torn');
                if (data && data.items) {
                    for (const [id, info] of Object.entries(data.items)) {
                        this.itemNameCache[id] = { name: info.name, value: info.market_value || 0 };
                    }
                }
            } catch (e2) {
                console.warn('[FinancePage] API fallback also failed:', e2);
            }
        }
    },

    // Look up a single item name, fetch from API if not in cache
    async _getItemName(itemId) {
        const id = String(itemId);
        if (this.itemNameCache[id]) return this.itemNameCache[id].name;
        // Not in cache, try API for this single item
        try {
            const data = await TornAPI.v1('items', 'torn');
            if (data && data.items) {
                for (const [k, info] of Object.entries(data.items)) {
                    this.itemNameCache[k] = { name: info.name, value: info.market_value || 0 };
                }
            }
        } catch (e) { /* ignore */ }
        return this.itemNameCache[id] ? this.itemNameCache[id].name : `物品#${id}`;
    },

    async _autoDetect() {
        Utils.showLoading('加载物品数据...');
        await this._loadItemNames();
        Utils.showLoading('获取交易日志...');
        try {
            const existingLogIds = new Set(this.transactions.map(t => String(t.log_id)).filter(id => id && id !== 'undefined'));
            const allRelevant = [];

            const currentEmployeeIds = new Set(this.employees.map(e => String(e.player_id)));

            // V2 log batches - each batch max 10 log type IDs
            const batches = [
                '4800,4810,4815,4820,6284',           // money + company deposit
                '4100,4101,4102,4103,4104,4105,4120,4121,4122,4123', // items
                '4400,4401,4406,4410,4420,4430,4431,4440,4441,4445', // trades 1 (added 4420: Trade expire)
                '4446,4447,4448,4449,4450,4451,4452,4480,4482'      // trades 2
            ];

            for (const batch of batches) {
                try {
                    const logData = await TornAPI.getUserLogByTypes(batch);
                    if (!logData || !logData.log || !logData.log.length) continue;

                    for (const entry of logData.log) {
                        const logId = entry.id;
                        if (!logId || existingLogIds.has(logId)) continue;

                        const logType = entry.details?.id || 0;
                        const isTrade = logType >= 4400 && logType <= 4499;

                        // Extract player ID from data
                        const d = entry.data || {};
                        // V2 logs can use user, sender, receiver, or even target in some cases
                        const empId = d.user || d.sender || d.receiver || d.target || 0;
                        const empIdStr = String(empId);

                        // Only include logs related to current employees
                        if (empIdStr !== '0' && currentEmployeeIds.has(empIdStr)) {
                            const emp = this.employees.find(e => String(e.player_id) === empIdStr);
                            allRelevant.push({
                                log_id: logId,
                                entry: entry,
                                empName: emp ? emp.name : '员工',
                                empId: empId,
                                isTrade: isTrade
                            });
                        }
                    }
                } catch (e) {
                    console.warn('[FinancePage] V2 log batch failed:', e);
                }
            }

            Utils.hideLoading();

            // Deduplicate trades
            const deduped = this._deduplicateTrades(allRelevant);

            if (!deduped.length) {
                Utils.toast('未找到新的相关日志条目', 'info');
                return;
            }

            deduped.forEach((item, idx) => item.idx = idx);
            this.adLogs = deduped;
            this.adFilterEmp = '';
            this.adFilterTime = 'week';

            const html = `
                <div class="p-6">
                    <h3 class="text-lg font-bold text-white mb-4">自动检测往来记录</h3>

                    <div class="flex items-center gap-2 mb-4 bg-torn-surface p-2 rounded border border-torn-border overflow-x-auto hide-scrollbar">
                        <select id="modal-ad-filter-time" class="input input-sm shrink-0 truncate" style="max-width: 90px;">
                            <option value="week">本周</option>
                            <option value="month">本月</option>
                            <option value="all">全部时间</option>
                        </select>
                        <select id="modal-ad-filter-emp" class="input input-sm shrink-0 truncate" style="max-width: 120px;">
                            <option value="">全部员工</option>
                            ${this.employees.map(e => `<option value="${e.player_id}">${e.name}</option>`).join('')}
                        </select>
                        <div class="flex items-center gap-2 ml-auto mr-2 whitespace-nowrap shrink-0">
                            <input type="checkbox" id="modal-ad-select-all" class="cursor-pointer" checked />
                            <label for="modal-ad-select-all" class="text-sm text-gray-300 cursor-pointer">全选</label>
                        </div>
                    </div>

                    <div id="modal-ad-list" class="space-y-2 max-h-64 overflow-y-auto mb-4"></div>

                    <div class="flex justify-end gap-2">
                        <button class="btn btn-secondary" id="modal-ad-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-import-btn">导入选中</button>
                    </div>
                </div>
            `;

            Utils.showModal(html);
            this._renderAutoDetectList();

            document.getElementById('modal-ad-filter-time')?.addEventListener('change', (e) => {
                this.adFilterTime = e.target.value;
                this._renderAutoDetectList();
            });

            document.getElementById('modal-ad-filter-emp')?.addEventListener('change', (e) => {
                this.adFilterEmp = e.target.value;
                this._renderAutoDetectList();
            });

            document.getElementById('modal-ad-select-all')?.addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.log-entry-cb');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
            });

            document.getElementById('modal-ad-cancel')?.addEventListener('click', () => Utils.hideModal());

            document.getElementById('modal-import-btn')?.addEventListener('click', async () => {
                const checked = [...document.querySelectorAll('.log-entry-cb:checked')];
                for (const cb of checked) {
                    const idx = parseInt(cb.dataset.idx);
                    const item = this.adLogs[idx];
                    if (!item) continue;

                    const entry = item.entry;
                    const d = entry.data || {};

                    // Handle synthetic trade entries (aggregated from multiple steps)
                    let cashAmount, absAmount, note;
                    if (entry._finalMoney !== undefined || entry._finalItems) {
                        cashAmount = entry._finalMoney || 0;
                        const tradeItems = entry._finalItems || [];
                        const itemsValue = this._calculateItemsValueFromList(tradeItems);
                        absAmount = Math.abs(cashAmount) || itemsValue;
                        const tradeId = entry._tradeId || '';
                        const itemDescs = tradeItems.map(it => {
                            const name = this.itemNameCache[it.id]?.name || `物品#${it.id}`;
                            return it.qty > 1 ? `${name} x${it.qty}` : name;
                        });
                        note = `交易 #${tradeId}${absAmount > 0 ? ' (' + Utils.formatMoney(absAmount) + (itemDescs.length ? ', ' + itemDescs.join(', ') : '') + ')' : ''}`;
                    } else {
                        // Regular V2 log entry
                        cashAmount = Math.abs(d.money || d.amount || d.cost || d.value || d.withdrawn || 0);
                        const itemsValue = this._calculateItemsValue(d);
                        absAmount = cashAmount || itemsValue;
                        const parts = [];
                        if (cashAmount) parts.push(Utils.formatMoney(cashAmount));
                        const itemDescs = this._parseItemsFromData(d);
                        parts.push(...itemDescs);
                        const title = entry.details?.title || '自动检测';
                        note = title + (parts.length ? ` (${parts.join(', ')})` : '');
                    }

                    let cat = 'other';
                    if (absAmount > 0 && absAmount === Number(this.config.weekly_tax_amount)) {
                        cat = 'tax';
                        note += ' (自动匹配税费)';
                    }

                    let ts = entry.timestamp || Date.now();
                    if (ts < 100000000000) ts *= 1000;
                    const txDate = new Date(ts).toISOString().slice(0, 10);

                    await DB.put('transactions', {
                        log_id: item.log_id,
                        player_id: item.empId,
                        player_name: item.empName,
                        date: txDate,
                        timestamp: ts,
                        amount: absAmount,
                        category: cat,
                        note: note
                    });
                }
                Utils.toast(`已导入 ${checked.length} 条交易`, 'success');
                Utils.hideModal();
                await this.render();
            });
        } catch (e) {
            Utils.hideLoading();
            Utils.toast(`获取日志失败: ${e.message}`, 'error');
        }
    },

    _deduplicateTrades(allRelevant) {
        const tradeEntries = [];
        const nonTrade = [];

        for (const item of allRelevant) {
            if (item.isTrade) {
                tradeEntries.push(item);
            } else {
                nonTrade.push(item);
            }
        }

        // Group trade entries by trade ID
        const byTradeId = {};
        for (const item of tradeEntries) {
            // Try both parsed_trade_id and trade_id
            let tradeId = item.entry?.data?.parsed_trade_id || item.entry?.data?.trade_id;
            // If trade_id is a string with HTML (common in some API responses), extract the numeric ID
            if (typeof tradeId === 'string' && tradeId.includes('ID=')) {
                const match = tradeId.match(/ID=(\d+)/);
                if (match) tradeId = match[1];
            }

            if (!tradeId) {
                // Skip orphaned trade logs that don't have a trade ID
                continue;
            }
            if (!byTradeId[tradeId]) byTradeId[tradeId] = [];
            byTradeId[tradeId].push(item);
        }

        const dedupedTrade = [];
        for (const [tradeId, steps] of Object.entries(byTradeId)) {
            steps.sort((a, b) => (a.entry.timestamp || 0) - (b.entry.timestamp || 0));

            // Only include completed trades: must have 'total' field AND not expired/cancelled
            const hasTotal = steps.some(s => s.entry?.data?.total !== undefined);
            if (!hasTotal) continue;

            // Skip trades that ended in expire (4420) or cancel (4410)
            const isExpiredOrCancelled = steps.some(s => {
                const logType = s.entry?.details?.id || 0;
                return logType === 4410 || logType === 4420;
            });
            if (isExpiredOrCancelled) continue;

            // Aggregate money and items from all steps
            let totalMoney = 0;
            const allItems = [];
            const traderUser = steps[0]?.entry?.data?.user || 0;

            for (const step of steps) {
                const d = step.entry?.data || {};
                if (d.money) totalMoney += d.money;
                if (d.items) allItems.push(...d.items);
            }

            // Merge duplicate items
            const merged = {};
            for (const it of allItems) {
                const k = `${it.id}_${it.uid || ''}`;
                merged[k] = merged[k] ? { ...merged[k], qty: merged[k].qty + it.qty } : { ...it };
            }

            dedupedTrade.push({
                log_id: `trade_final_${tradeId}`,
                entry: {
                    ...steps[steps.length - 1].entry,
                    _tradeId: tradeId,
                    _finalMoney: totalMoney,
                    _finalItems: Object.values(merged)
                },
                empName: this.employees.find(e => String(e.player_id) === String(traderUser))?.name || '交易对方',
                empId: traderUser,
                isTrade: true
            });
        }

        return [...nonTrade, ...dedupedTrade];
    },

    _renderAutoDetectList() {
        const listContainer = document.getElementById('modal-ad-list');
        if (!listContainer) return;

        let filtered = this.adLogs;

        if (this.adFilterEmp) {
            filtered = filtered.filter(item => String(item.empId) === this.adFilterEmp);
        }

        const now = new Date();
        if (this.adFilterTime === 'week') {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - (now.getDay() || 7) + 1);
            startOfWeek.setHours(0, 0, 0, 0);
            filtered = filtered.filter(item => (item.entry.timestamp || 0) >= startOfWeek.getTime() / 1000);
        } else if (this.adFilterTime === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            filtered = filtered.filter(item => (item.entry.timestamp || 0) >= startOfMonth.getTime() / 1000);
        }

        if (!filtered.length) {
            listContainer.innerHTML = '<div class="text-gray-500 text-sm p-4 text-center">暂无符合条件的记录</div>';
            return;
        }

        const getDetails = (entry) => {
            const d = entry.data || {};
            const money = Math.abs(d.money || d.cost || d.amount || d.value || 0);
            const itemsValue = this._calculateItemsValue(d);
            
            let parts = [];
            if (money) parts.push(`${Utils.formatMoney(money)}`);
            if (itemsValue && !money) parts.push(`价值 ${Utils.formatMoney(itemsValue)}`);
            
            // Parse items from all possible API formats
            const itemDescriptions = this._parseItemsFromData(d);
            parts.push(...itemDescriptions);
            
            return parts.length ? `<span class="text-torn-green ml-2 font-mono font-bold">${parts.join(', ')}</span>` : '';
        };

        listContainer.innerHTML = filtered.map(item => `
            <label class="flex items-center gap-3 p-2 rounded hover:bg-torn-surface cursor-pointer">
                <input type="checkbox" class="log-entry-cb" data-idx="${item.idx}" checked />
                <div class="flex-1">
                    <div class="text-white text-sm">
                        <span class="text-torn-gold mr-1">[${item.empName}]</span>${item.isTrade ? 'Trade' : (item.entry.title || item.entry.details?.title || '日志条目')}${getDetails(item.entry)}
                    </div>
                    <div class="text-gray-500 text-xs">${Utils.formatDateTime(item.entry.timestamp)}</div>
                </div>
            </label>
        `).join('');

        const selectAllCb = document.getElementById('modal-ad-select-all');
        if (selectAllCb) selectAllCb.checked = true;
    }
};

// Global real-time conversion for money inputs (k, m, b)
document.body.addEventListener('input', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('money-input')) {
        const val = e.target.value.toLowerCase().trim();
        if (val.endsWith('k') || val.endsWith('m') || val.endsWith('b')) {
            const parsed = Utils.parseMoneyInput(val);
            if (parsed && !isNaN(parsed)) {
                e.target.value = parsed.toLocaleString('en-US');
            }
        }
    }
});
