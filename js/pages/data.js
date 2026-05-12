// Data Page - Import/Export and storage management
window.DataPage = {
    stores: [
        'snapshots', 'employee_history', 'stock_history', 'transactions',
        'employee_notes', 'training_records', 'training_config', 'rehab_records',
        'rehab_config', 'boost_sellers', 'company_types', 'settings', 'employees_master'
    ],
    counts: {},

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载存储信息...');
        try {
            this.counts = {};
            for (const store of this.stores) {
                try {
                    this.counts[store] = await DB.count(store);
                } catch (e) {
                    this.counts[store] = 0;
                }
            }
            Utils.hideLoading();
            c.innerHTML = this._buildPageHTML();
            this._bindEvents();
        } catch (e) {
            Utils.hideLoading();
            c.innerHTML = `<div class="text-red-400 p-4">加载失败: ${e.message}</div>`;
        }
    },

    _buildPageHTML() {
        const totalRecords = Object.values(this.counts).reduce((s, c) => s + c, 0);
        const storeLabels = {
            snapshots: ['快照', 'camera'],
            employee_history: ['员工历史', 'history'],
            stock_history: ['库存历史', 'chart-line'],
            transactions: ['交易记录', 'exchange-alt'],
            employee_notes: ['员工备注', 'sticky-note'],
            training_records: ['训练记录', 'dumbbell'],
            training_config: ['训练配置', 'cog'],
            rehab_records: ['康复记录', 'syringe'],
            rehab_config: ['康复配置', 'cog'],
            boost_sellers: ['Boost卖家', 'rocket'],
            company_types: ['公司类型', 'building'],
            settings: ['设置', 'cog'],
            employees_master: ['员工主表', 'users']
        };

        const storeCards = this.stores.map(store => {
            const [label, icon] = storeLabels[store] || [store, 'circle'];
            const count = this.counts[store] || 0;
            return `
                <div class="bg-torn-surface rounded-lg p-3 border border-torn-border">
                    <div class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                        <i class="fas fa-${icon}"></i>${label}
                    </div>
                    <div class="text-white font-bold text-lg">${count}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-xl font-bold text-white flex items-center gap-2">
                    <i class="fas fa-database text-torn-blue"></i> 数据管理
                </h1>
                <button id="data-refresh" class="btn btn-secondary btn-sm">
                    <i class="fas fa-sync-alt"></i> 刷新
                </button>
            </div>

            <!-- Storage Stats -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">存储统计</h3>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    ${UI.kpiCard('fas fa-database', '总记录数', String(totalRecords), '所有存储', 'accent')}
                    ${storeCards}
                </div>
            </div>

            <!-- Actions -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">数据操作</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <!-- Export -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-torn-green font-bold mb-2">
                            <i class="fas fa-download mr-2"></i>导出数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">下载完整JSON备份文件</div>
                        <button id="data-export" class="btn btn-success w-full">导出备份</button>
                    </div>
                    <!-- Import -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-torn-blue font-bold mb-2">
                            <i class="fas fa-upload mr-2"></i>导入数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">从JSON备份文件恢复数据</div>
                        <button id="data-import" class="btn btn-primary w-full">导入备份</button>
                    </div>
                    <!-- Clear -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-red-400 font-bold mb-2">
                            <i class="fas fa-trash-alt mr-2"></i>清空数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">永久删除所有存储数据，不可撤销</div>
                        <button id="data-clear" class="btn w-full bg-red-600 hover:bg-red-700 text-white">清空所有数据</button>
                    </div>
                </div>
            </div>
        `;
    },

    _bindEvents() {
        document.getElementById('data-refresh')?.addEventListener('click', () => this.render());
        document.getElementById('data-export')?.addEventListener('click', () => this.exportData());
        document.getElementById('data-import')?.addEventListener('click', () => this.importData());
        document.getElementById('data-clear')?.addEventListener('click', () => this.clearAllData());
    },

    async exportData() {
        try {
            Utils.showLoading('正在导出数据...');
            const data = await DB.exportAll();
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `torn-company-backup-${Utils.todayKey()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            Utils.hideLoading();
            Utils.toast('备份导出成功', 'success');
        } catch (e) {
            Utils.hideLoading();
            Utils.toast(`导出失败: ${e.message}`, 'error');
        }
    },

    importData() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    this._showImportPreview(data);
                } catch (err) {
                    Utils.toast('无效的JSON文件', 'error');
                }
            };
            reader.readAsText(file);
        });
        fileInput.click();
    },

    _showImportPreview(data) {
        const content = document.createElement('div');
        content.className = 'p-6';

        let totalImport = 0;
        let hasOverwrite = false;

        const storeRows = this.stores.map(store => {
            const importCount = data[store]?.length || 0;
            const currentCount = this.counts[store] || 0;
            totalImport += importCount;
            if (currentCount > 0 && importCount > 0) hasOverwrite = true;
            const countClass = importCount > 0 ? 'text-torn-green font-bold' : 'text-gray-500';
            return `
                <div class="flex justify-between items-center py-1 px-2 rounded bg-torn-surface">
                    <span class="text-gray-300 text-sm">${store}</span>
                    <div class="flex items-center gap-3">
                        <span class="text-gray-500 text-xs">当前: ${currentCount}</span>
                        <i class="fas fa-arrow-right text-gray-600 text-xs"></i>
                        <span class="${countClass}">${importCount}</span>
                    </div>
                </div>
            `;
        }).join('');

        const warning = hasOverwrite ? `
            <div class="bg-yellow-900/30 border border-yellow-500/50 rounded-lg p-3 mb-4 flex items-center gap-2">
                <i class="fas fa-exclamation-triangle text-yellow-400"></i>
                <span class="text-yellow-300 text-sm">警告: 导入将覆盖已有数据的存储</span>
            </div>
        ` : '';

        content.innerHTML = `
            <h3 class="text-lg font-bold text-white mb-2">
                <i class="fas fa-file-import mr-2 text-torn-blue"></i>导入预览
            </h3>
            ${data._exportDate ? `<div class="text-gray-400 text-sm mb-4">备份时间: ${data._exportDate}</div>` : ''}
            <div class="space-y-2 mb-4 max-h-48 overflow-y-auto">${storeRows}</div>
            ${warning}
            <div class="text-white mb-4">总导入记录数: ${totalImport}</div>
            <div class="flex justify-end gap-2">
                <button id="import-cancel" class="btn btn-secondary">取消</button>
                <button id="import-confirm" class="btn btn-primary">确认导入</button>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#import-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#import-confirm').addEventListener('click', async () => {
            Utils.hideModal();
            Utils.showLoading('正在导入数据...');
            try {
                await DB.importAll(data);
                Utils.hideLoading();
                Utils.toast('数据导入成功', 'success');
                this.render();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`导入失败: ${e.message}`, 'error');
            }
        });
    },

    clearAllData() {
        const content = document.createElement('div');
        content.className = 'p-6';
        content.innerHTML = `
            <h3 class="text-lg font-bold text-red-400 mb-2">
                <i class="fas fa-exclamation-triangle mr-2"></i>清空所有数据
            </h3>
            <div class="text-gray-300 mb-4">
                这将永久删除所有存储的数据，包括快照、交易记录、训练记录和设置。
            </div>
            <div class="text-red-300 text-sm mb-4 font-bold">此操作不可撤销！</div>
            <div class="mb-4">
                <label class="text-gray-400 text-sm mb-1 block">输入 "DELETE" 确认:</label>
                <input id="clear-confirm-input" class="input" type="text" placeholder="DELETE">
            </div>
            <div class="flex justify-end gap-2">
                <button id="clear-cancel" class="btn btn-secondary">取消</button>
                <button id="clear-confirm" class="btn bg-red-600 hover:bg-red-700 text-white">删除所有数据</button>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#clear-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#clear-confirm').addEventListener('click', async () => {
            const inputVal = content.querySelector('#clear-confirm-input').value;
            if (inputVal !== 'DELETE') {
                Utils.toast('请输入 DELETE 确认', 'error');
                return;
            }
            if (!confirm('确定要删除所有数据吗？此操作不可撤销。')) return;

            Utils.hideModal();
            Utils.showLoading('正在清空数据...');
            try {
                for (const store of this.stores) {
                    await DB.clear(store);
                }
                Utils.hideLoading();
                Utils.toast('所有数据已清空', 'success');
                this.render();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`清空失败: ${e.message}`, 'error');
            }
        });
    }
};
