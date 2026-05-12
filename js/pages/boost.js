// Boost Page - 10-star logistics boost management (buyer perspective)
window.BoostPage = {
    sellers: [],

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载Boost数据...');
        try {
            this.sellers = await DB.getAll('boost_sellers');
            // Also load boost transactions for stats
            const allTx = (await DB.getAll('transactions')) || [];
            this.boostTransactions = allTx.filter(t => t.category === 'boost');
            Utils.hideLoading();
            c.innerHTML = this._buildPageHTML();
            this._bindEvents();
        } catch (e) {
            Utils.hideLoading();
            c.innerHTML = `<div class="text-red-400 p-4">加载失败: ${e.message}</div>`;
        }
    },

    _buildPageHTML() {
        const s = this.sellers;
        const totalSellers = s.length;
        // Total boosts purchased = sum of points_used / 250 across all sellers
        const totalBoostsPurchased = s.reduce((sum, x) => sum + Math.floor((x.points_used || 0) / 250), 0);
        // Total cost paid from recorded transactions
        const totalCostPaid = (this.boostTransactions || []).reduce((sum, t) => sum + (t.amount || 0), 0);

        return `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-xl font-bold text-white flex items-center gap-2">
                    <i class="fas fa-rocket text-torn-gold"></i> Boost购买管理
                </h1>
                <div class="flex gap-2">
                    <button id="boost-add-seller" class="btn btn-primary btn-sm">
                        <i class="fas fa-plus"></i> 添加卖家
                    </button>
                    <button id="boost-refresh" class="btn btn-secondary btn-sm">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                ${UI.kpiCard('fas fa-users', '跟踪卖家数', String(totalSellers), '已记录', 'accent')}
                ${UI.kpiCard('fas fa-bolt', '已购买Boost', String(totalBoostsPurchased), '总计', 'gold')}
                ${UI.kpiCard('fas fa-dollar-sign', '总花费', Utils.formatMoney(totalCostPaid), '已付款项', 'green')}
            </div>
            <div id="boost-seller-table" class="card mb-6"></div>
        `;
    },

    _bindEvents() {
        document.getElementById('boost-add-seller')?.addEventListener('click', () => this.showAddSellerModal());
        document.getElementById('boost-refresh')?.addEventListener('click', () => this.render());
        this._renderSellerTable();
    },

    _renderSellerTable() {
        const container = document.getElementById('boost-seller-table');
        if (!container) return;

        if (!this.sellers.length) {
            container.innerHTML = UI.emptyState('fas fa-rocket', '暂无Boost卖家，请添加', '添加卖家', 'boost-add-empty');
            document.getElementById('boost-add-empty')?.addEventListener('click', () => this.showAddSellerModal());
            return;
        }

        const headers = [
            { key: 'name', label: '卖家名称', sortable: true },
            { key: 'price', label: '单价/Boost', sortable: true },
            { key: 'remaining', label: '卖家剩余点数', sortable: true },
            { key: 'boosts_avail', label: '可购买Boost数', sortable: true },
            { key: 'lastPurchased', label: '上次购买', sortable: true },
            { key: 'notes', label: '备注', sortable: false },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = this.sellers.map(seller => {
            const remaining = (seller.total_points || 0) - (seller.points_used || 0);
            const boostsAvail = Math.max(0, Math.floor(remaining / 250));
            const remainColor = remaining < 250 ? 'text-red-400' : 'text-torn-green';
            const lastPurchased = seller.last_updated ? Utils.relativeTime(seller.last_updated / 1000) : '-';

            let actionsHtml = '<div class="flex gap-1">';
            if (boostsAvail > 0) {
                actionsHtml += `<button class="btn btn-xs btn-success boost-buy-btn" data-id="${seller.id}"><i class="fas fa-bolt"></i> 购买</button>`;
            }
            actionsHtml += `<button class="btn btn-xs btn-secondary boost-edit-btn" data-id="${seller.id}"><i class="fas fa-edit"></i></button>`;
            actionsHtml += `<button class="btn btn-xs btn-secondary boost-delete-btn" data-id="${seller.id}"><i class="fas fa-trash"></i></button>`;
            actionsHtml += '</div>';

            return {
                id: seller.id,
                name: seller.player_name || `ID:${seller.player_id}`,
                price: Utils.formatMoney((seller.price_per_boost || 0) * 1000),
                remaining: `<span class="${remainColor}">${Utils.formatShort(remaining)}</span>`,
                boosts_avail: String(boostsAvail),
                lastPurchased: lastPurchased,
                notes: seller.notes || '-',
                actions: actionsHtml
            };
        });

        container.innerHTML = UI.dataTable({ headers, rows, id: 'boost-table', sortable: true, emptyText: '暂无数据' });
        UI.initSortable('boost-table');

        // Bind action buttons
        container.querySelectorAll('.boost-buy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.id);
                const seller = this.sellers.find(s => s.id === id);
                if (seller) this.buyBoost(seller);
            });
        });
        container.querySelectorAll('.boost-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.id);
                const seller = this.sellers.find(s => s.id === id);
                if (seller) this.showEditSellerModal(seller);
            });
        });
        container.querySelectorAll('.boost-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.id);
                const seller = this.sellers.find(s => s.id === id);
                if (seller) this.deleteSeller(seller);
            });
        });
    },

    showAddSellerModal() {
        const content = document.createElement('div');
        content.className = 'p-6';
        content.innerHTML = `
            <h3 class="text-lg font-bold text-white mb-4">
                <i class="fas fa-user-plus mr-2 text-torn-gold"></i>添加Boost卖家
            </h3>
            <div class="space-y-4">
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">玩家ID</label>
                    <input id="add-player-id" class="input" type="text" placeholder="Torn玩家ID">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">玩家名称</label>
                    <input id="add-player-name" class="input" type="text" placeholder="卖家名称">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">单价/Boost ($K)</label>
                    <input id="add-price" class="input" type="number" min="0" placeholder="单位: 千美元">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">卖家总点数</label>
                    <input id="add-total-points" class="input" type="number" min="0" placeholder="卖家可用总点数">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">备注</label>
                    <input id="add-notes" class="input" type="text" placeholder="可选备注">
                </div>
                <div class="flex justify-end gap-2 mt-6">
                    <button id="add-cancel" class="btn btn-secondary">取消</button>
                    <button id="add-save" class="btn btn-primary">添加卖家</button>
                </div>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#add-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#add-save').addEventListener('click', async () => {
            const playerId = content.querySelector('#add-player-id').value.trim();
            const playerName = content.querySelector('#add-player-name').value.trim();
            const price = parseInt(content.querySelector('#add-price').value) || 0;
            const totalPoints = parseInt(content.querySelector('#add-total-points').value) || 0;
            const notes = content.querySelector('#add-notes').value.trim();

            if (!playerId || !playerName) {
                Utils.toast('请填写玩家ID和名称', 'error');
                return;
            }

            await DB.put('boost_sellers', {
                player_id: playerId,
                player_name: playerName,
                price_per_boost: price,
                total_points: totalPoints,
                points_used: 0,
                last_updated: Date.now(),
                notes: notes
            });

            Utils.toast('卖家已添加', 'success');
            Utils.hideModal();
            this.render();
        });
    },

    showEditSellerModal(seller) {
        const content = document.createElement('div');
        content.className = 'p-6';
        content.innerHTML = `
            <h3 class="text-lg font-bold text-white mb-4">
                <i class="fas fa-edit mr-2 text-torn-gold"></i>编辑卖家: ${seller.player_name}
            </h3>
            <div class="space-y-4">
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">玩家名称</label>
                    <input id="edit-name" class="input" type="text" value="${seller.player_name || ''}">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">单价/Boost ($K)</label>
                    <input id="edit-price" class="input" type="number" min="0" value="${seller.price_per_boost || 0}">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">卖家总点数</label>
                    <input id="edit-total" class="input" type="number" min="0" value="${seller.total_points || 0}">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">已购买消耗点数</label>
                    <input id="edit-used" class="input" type="number" min="0" value="${seller.points_used || 0}">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">备注</label>
                    <input id="edit-notes" class="input" type="text" value="${seller.notes || ''}">
                </div>
                <div class="flex justify-end gap-2 mt-6">
                    <button id="edit-cancel" class="btn btn-secondary">取消</button>
                    <button id="edit-save" class="btn btn-primary">保存</button>
                </div>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#edit-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#edit-save').addEventListener('click', async () => {
            seller.player_name = content.querySelector('#edit-name').value.trim();
            seller.price_per_boost = parseInt(content.querySelector('#edit-price').value) || 0;
            seller.total_points = parseInt(content.querySelector('#edit-total').value) || 0;
            seller.points_used = parseInt(content.querySelector('#edit-used').value) || 0;
            seller.notes = content.querySelector('#edit-notes').value.trim();
            seller.last_updated = Date.now();

            await DB.put('boost_sellers', seller);
            Utils.toast('卖家已更新', 'success');
            Utils.hideModal();
            this.render();
        });
    },

    async buyBoost(seller) {
        const remaining = (seller.total_points || 0) - (seller.points_used || 0);
        if (remaining < 250) {
            Utils.toast('卖家点数不足，无法购买Boost', 'error');
            return;
        }

        if (!confirm(`确认从 ${seller.player_name} 购买1个Boost？\n价格: ${Utils.formatMoney((seller.price_per_boost || 0) * 1000)}`)) return;

        // Deduct 250 points from seller
        seller.points_used = (seller.points_used || 0) + 250;
        seller.last_updated = Date.now();
        await DB.put('boost_sellers', seller);

        // Record transaction
        await DB.put('transactions', {
            player_id: seller.player_id,
            player_name: seller.player_name,
            date: Utils.todayKey(),
            timestamp: Date.now(),
            amount: (seller.price_per_boost || 0) * 1000,
            category: 'boost',
            note: '购买Boost'
        });

        Utils.toast(`已从 ${seller.player_name} 购买1个Boost`, 'success');
        this.render();
    },

    async deleteSeller(seller) {
        if (!confirm(`确认删除卖家 ${seller.player_name}？此操作不可撤销。`)) return;
        await DB.delete('boost_sellers', seller.id);
        Utils.toast('卖家已删除', 'info');
        this.render();
    }
};
