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
        let weekTax = 0, weekTrain = 0, weekBoost = 0;
        let monthTax = 0, monthTrain = 0, monthBoost = 0;

        for (const tx of this.transactions) {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000; // normalize seconds to ms

            if (ts >= startOfWeek.getTime()) {
                if (tx.category === 'tax') weekTax += tx.amount;
                if (tx.category === 'train') weekTrain += tx.amount;
                if (tx.category === 'boost') weekBoost += tx.amount;
            }
            if (ts >= startOfMonth.getTime()) {
                if (tx.category === 'tax') monthTax += tx.amount;
                if (tx.category === 'train') monthTrain += tx.amount;
                if (tx.category === 'boost') monthBoost += tx.amount;
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
        
        const weekTotalIncome = weekTax + weekTrain + weekIncomeAPI;
        const weekTotalExpense = weekBoost + weekCostAPI + weekAdFeeAPI;
        const weekNetProfit = weekTotalIncome - weekTotalExpense;

        // Calculate Monthly (当月已发生的数据 + 本周的预测数据)
        const monthTotalIncome = monthTax + monthTrain + weekIncomeAPI;
        const monthTotalExpense = monthBoost + weekCostAPI + weekAdFeeAPI;
        const monthNetProfit = monthTotalIncome - monthTotalExpense;

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-week mr-2 text-torn-accent"></i>本周概览 (日历周预估)
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    ${UI.kpiCard('fas fa-arrow-down', '总支出', Utils.formatMoney(weekTotalExpense), '成本+广告+Boost', 'red')}
                    ${UI.kpiCard('fas fa-arrow-up', '总收入', Utils.formatMoney(weekTotalIncome), '税费+训练+日收入', 'green')}
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

        const catMap = {
            train: { cls: 'badge-green', label: '训练' },
            tax:   { cls: 'badge-blue',  label: '税务' },
            boost: { cls: 'badge-purple', label: '加成' },
            other: { cls: 'badge-gray',  label: '其他' }
        };

        const rows = sortedTx.map(tx => {
            const cat = catMap[tx.category] || catMap.other;
            return {
                select: `<input type="checkbox" class="tx-row-cb cursor-pointer" data-tx-id="${tx.id}" />`,
                id: tx.id,
                date: tx.date || '-',
                employee: tx.player_name || '-',
                amount: Utils.formatMoney(tx.amount || 0),
                category: `<span class="badge ${cat.cls}">${cat.label}</span>`,
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
                        <input type="text" class="input" id="cfg-weekly-tax" value="${weeklyTax}" placeholder="支持 k/m/b 后缀" />
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
            } else if (e.target.id === 'modal-ad-filter-emp') {
                this.adFilterEmp = e.target.value;
                this._renderAutoDetectList();
            } else if (e.target.id === 'modal-ad-filter-time') {
                this.adFilterTime = e.target.value;
                this._renderAutoDetectList();
            } else if (e.target.id === 'modal-ad-select-all') {
                const checkboxes = document.querySelectorAll('.log-entry-cb');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
            }
        };
        c.addEventListener('change', this._changeHandler);

        // Remove old listeners to prevent stacking
        if (this._clickHandler) c.removeEventListener('click', this._clickHandler);

        this._clickHandler = async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

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
                        <input type="text" class="input" id="modal-tx-amount" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-tx-cat">
                            <option value="train">训练 (train)</option>
                            <option value="tax">税务 (tax)</option>
                            <option value="boost">加成 (boost)</option>
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
                        <input type="text" class="input" id="modal-edit-amount" value="${tx.amount || 0}" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-edit-cat">
                            <option value="train" ${tx.category === 'train' ? 'selected' : ''}>训练 (train)</option>
                            <option value="tax" ${tx.category === 'tax' ? 'selected' : ''}>税务 (tax)</option>
                            <option value="boost" ${tx.category === 'boost' ? 'selected' : ''}>加成 (boost)</option>
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
                        category: cats[i],
                        note: notes[i] || `从交易#${tx.id}拆分`,
                        split_from: tx.id
                    });
                }
            }

            Utils.toast('交易已拆分', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _splitPartHTML(index) {
        return `
            <div class="flex gap-2 items-end">
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">部分${index} 金额</label>
                    <input type="text" class="input input-sm split-amount" placeholder="支持 k/m/b" />
                </div>
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">分类</label>
                    <select class="input input-sm split-cat">
                        <option value="train">train</option>
                        <option value="tax">tax</option>
                        <option value="boost">boost</option>
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

    async _autoDetect() {
        Utils.showLoading('获取员工往来日志...');
        try {
            console.log('[FinancePage] Fetching user log for auto-detect by target...');
            
            const existingLogIds = new Set(this.transactions.map(t => t.log_id).filter(Boolean));
            const allRelevant = [];

            for (const emp of this.employees) {
                try {
                    const logData = await TornAPI.getUserLogForTarget(emp.player_id);
                    if (!logData || !logData.log) continue;

                    const entries = Array.isArray(logData.log) ? logData.log : Object.values(logData.log);
                    
                    for (const entry of entries) {
                        const logId = String(entry.id || entry.log_id || '');
                        if (logId && existingLogIds.has(logId)) continue; 

                        const cat = (entry.category || '').toLowerCase();
                        const title = (entry.title || '').toLowerCase();
                        
                        const isRelevant = 
                            cat.includes('money') || 
                            cat.includes('item') || 
                            cat.includes('trade') ||
                            title.includes('money') ||
                            title.includes('item') ||
                            title.includes('trade') ||
                            title.includes('sent you') ||
                            title.includes('sent to');

                        if (!isRelevant) continue;

                        allRelevant.push({
                            log_id: logId,
                            entry: entry,
                            empName: emp.name,
                            empId: emp.player_id
                        });
                    }
                } catch (apiErr) {
                    console.warn(`[FinancePage] Failed to fetch logs for ${emp.name}: `, apiErr);
                }
            }
            
            Utils.hideLoading();

            if (!allRelevant.length) {
                Utils.toast('未找到新的相关日志条目', 'info');
                return;
            }

            allRelevant.forEach((item, idx) => item.idx = idx);
            this.adLogs = allRelevant;
            this.adFilterEmp = '';
            this.adFilterTime = 'week';

            const empOptions = this.employees.map(e => `<option value="${e.player_id}">${e.name}</option>`).join('');

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
                            ${empOptions}
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

            document.getElementById('modal-ad-cancel')?.addEventListener('click', () => Utils.hideModal());

            document.getElementById('modal-import-btn')?.addEventListener('click', async () => {
                const checked = [...document.querySelectorAll('.log-entry-cb:checked')];
                for (const cb of checked) {
                    const idx = parseInt(cb.dataset.idx);
                    const item = this.adLogs[idx];
                    if (!item) continue;

                    const entry = item.entry;
                    const amount = entry.data?.money || entry.data?.amount || 0;
                    
                    let ts = entry.timestamp || Date.now();
                    if (ts < 100000000000) ts *= 1000;

                    await DB.put('transactions', {
                        log_id: item.log_id,
                        player_id: item.empId,
                        player_name: item.empName,
                        date: Utils.todayKey(),
                        timestamp: ts,
                        amount: Math.abs(amount),
                        category: 'other',
                        note: entry.title || '自动检测'
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
            const qty = d.quantity || d.items || 0;
            const itemName = d.item_name || (typeof d.item === 'string' ? d.item : '');
            
            let parts = [];
            if (money) parts.push(`${Utils.formatMoney(money)}`);
            if (itemName && qty) parts.push(`${itemName} x${qty}`);
            else if (itemName) parts.push(`${itemName}`);
            else if (qty) parts.push(`${qty}件物品`);
            
            return parts.length ? `<span class="text-torn-green ml-2 font-mono font-bold">${parts.join(', ')}</span>` : '';
        };

        listContainer.innerHTML = filtered.map(item => `
            <label class="flex items-center gap-3 p-2 rounded hover:bg-torn-surface cursor-pointer">
                <input type="checkbox" class="log-entry-cb" data-idx="${item.idx}" checked />
                <div class="flex-1">
                    <div class="text-white text-sm">
                        <span class="text-torn-gold mr-1">[${item.empName}]</span>${item.entry.title || '日志条目'}${getDetails(item.entry)}
                    </div>
                    <div class="text-gray-500 text-xs">${Utils.formatDateTime(item.entry.timestamp)}</div>
                </div>
            </label>
        `).join('');

        const selectAllCb = document.getElementById('modal-ad-select-all');
        if (selectAllCb) selectAllCb.checked = true;
    }
};
