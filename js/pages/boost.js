// Boost Page - 10-star logistics boost management (buyer perspective)
window.BoostPage = {
    sellers: [],

    // Parse URLs and plain IDs from input text
    _parseURLIDs(input) {
        if (!input) return [];
        const ids = new Set();
        const urlPattern = /(?:https?:\/\/)?(?:www\.)?torn\.com\/profiles\.php\?[XN]ID=(\d+)/gi;
        let match;
        while ((match = urlPattern.exec(input)) !== null) {
            ids.add(match[1]);
        }
        // If no URLs found, fall back to extracting plain numbers
        if (ids.size === 0) {
            const numPattern = /\b(\d+)\b/g;
            while ((match = numPattern.exec(input)) !== null) {
                ids.add(match[1]);
            }
        }
        return [...ids];
    },

    // Resolve player name from Torn API
    async _resolvePlayerName(playerId) {
        try {
            const info = await TornAPI.getPlayerInfo(playerId);
            return info.name || null;
        } catch (e) {
            console.warn(`[BoostPage] Failed to resolve name for ID ${playerId}:`, e.message);
            return null;
        }
    },

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载Boost数据...');
        try {
            this.sellers = await DB.getAll('boost_sellers');
            for (const s of this.sellers) {
                const norm = Utils.normalizeBoostPrice(s.price_per_boost);
                if (norm !== s.price_per_boost) {
                    s.price_per_boost = norm;
                    await DB.put('boost_sellers', s);
                }
            }
            // Also load boost transactions for stats
            const allTx = (await DB.getAll('transactions')) || [];
            this.boostTransactions = allTx
                .filter(t => t.category === 'boost')
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            await Utils.reconcileBoostSellersFromTransactions();
            this.sellers = await DB.getAll('boost_sellers');
            this.sellers.sort((a, b) => {
                const priceA = Utils.normalizeBoostPrice(a.price_per_boost) || 0;
                const priceB = Utils.normalizeBoostPrice(b.price_per_boost) || 0;
                return priceA - priceB;
            });
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
        const totalBoostsPurchased = s.reduce((sum, x) => sum + Math.floor((x.points_used || 0) / BOOST_POINTS_PER_USE), 0);
        // Total cost paid from recorded transactions
        const totalCostPaid = (this.boostTransactions || []).reduce((sum, t) => sum + (t.amount || 0), 0);

        // Check current boost status & expiry day point prediction
        let boostStatusHtml = '';
        let daysUntilExpiry = 0;
        let expiryDate = null;
        const latestTx = this.boostTransactions ? this.boostTransactions[0] : null;
        if (latestTx) {
            let ts = latestTx.timestamp || 0;
            if (ts > 0 && ts < 1e12) ts *= 1000;
            const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
            const expiryTime = ts + oneWeekMs;
            const remainingTime = expiryTime - Date.now();
            
            if (remainingTime > 0) {
                const daysLeft = Math.floor(remainingTime / (24 * 60 * 60 * 1000));
                const hoursLeft = Math.floor((remainingTime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                boostStatusHtml = `
                    <span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 12px; font-weight: 600;">
                        <i class="fas fa-check-circle mr-1"></i> 生效中 (剩余 ${daysLeft}天${hoursLeft}小时)
                    </span>
                `;
                
                // Calculate calendar days from today to expiry day to count how many point regens will happen
                const nowObj = new Date();
                const todayObj = new Date(nowObj.getFullYear(), nowObj.getMonth(), nowObj.getDate());
                const expObj = new Date(expiryTime);
                const expDayObj = new Date(expObj.getFullYear(), expObj.getMonth(), expObj.getDate());
                const diffTime = expDayObj - todayObj;
                daysUntilExpiry = Math.round(diffTime / (1000 * 60 * 60 * 24));
                if (daysUntilExpiry < 0) daysUntilExpiry = 0;
                expiryDate = expDayObj;
            } else {
                boostStatusHtml = `
                    <span class="badge badge-red" style="font-size: 0.85rem; padding: 4px 12px; font-weight: 600;">
                        <i class="fas fa-exclamation-circle mr-1"></i> 已过期 (请尽快购买)
                    </span>
                `;
            }
        } else {
            boostStatusHtml = `
                <span class="badge badge-gray" style="font-size: 0.85rem; padding: 4px 12px; font-weight: 600;">
                    <i class="fas fa-info-circle mr-1"></i> 暂无生效 (未记录购买)
                </span>
            `;
        }

        // Find recommended seller for next purchase (evaluated at/after expiration date)
        let nextSellerHtml = '';
        if (s.length > 0) {
            const sortedSellers = [...s].sort((a, b) => {
                const remA = (a.total_points || 0) - (a.points_used || 0) + daysUntilExpiry * BOOST_DAILY_REGEN;
                const remB = (b.total_points || 0) - (b.points_used || 0) + daysUntilExpiry * BOOST_DAILY_REGEN;
                const availA = remA >= BOOST_POINTS_PER_USE;
                const availB = remB >= BOOST_POINTS_PER_USE;
                
                if (availA && !availB) return -1;
                if (!availA && availB) return 1;
                
                if (!availA && !availB) {
                    if (remA !== remB) return remB - remA; // More points means fewer days needed
                }
                
                const priceA = Utils.normalizeBoostPrice(a.price_per_boost);
                const priceB = Utils.normalizeBoostPrice(b.price_per_boost);
                return priceA - priceB;
            });
            
            const bestSeller = sortedSellers[0];
            const currentRem = (bestSeller.total_points || 0) - (bestSeller.points_used || 0);
            const predictedRem = currentRem + daysUntilExpiry * BOOST_DAILY_REGEN;
            const priceVal = Utils.normalizeBoostPrice(bestSeller.price_per_boost);
            const priceStr = Utils.formatMoney(priceVal);
            
            if (predictedRem >= BOOST_POINTS_PER_USE) {
                if (daysUntilExpiry > 0) {
                    const mm = String(expiryDate.getMonth() + 1).padStart(2, '0');
                    const dd = String(expiryDate.getDate()).padStart(2, '0');
                    nextSellerHtml = `
                        <div class="flex items-center gap-2">
                            <span class="text-white font-medium">${bestSeller.player_name || `ID:${bestSeller.player_id}`}</span>
                            <span class="text-torn-green font-bold">(${priceStr} / ${mm}-${dd} 过期当天可用)</span>
                        </div>
                    `;
                } else {
                    nextSellerHtml = `
                        <div class="flex items-center gap-2">
                            <span class="text-white font-medium">${bestSeller.player_name || `ID:${bestSeller.player_id}`}</span>
                            <span class="text-torn-green font-bold">(${priceStr})</span>
                            <button id="recommended-buy-btn" class="btn btn-xs btn-success ml-2" data-id="${bestSeller.id}">
                                <i class="fas fa-bolt"></i> 一键购买
                            </button>
                        </div>
                    `;
                }
            } else {
                const pointsNeeded = BOOST_POINTS_PER_USE - predictedRem;
                const extraDaysNeeded = Math.ceil(pointsNeeded / BOOST_DAILY_REGEN);
                const totalDaysNeeded = daysUntilExpiry + extraDaysNeeded;
                const now = new Date();
                const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + totalDaysNeeded);
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
                const dd = String(targetDate.getDate()).padStart(2, '0');
                nextSellerHtml = `
                    <div class="flex items-center gap-2">
                        <span class="text-white font-medium">${bestSeller.player_name || `ID:${bestSeller.player_id}`}</span>
                        <span class="text-gray-400">(${priceStr} / ${mm}-${dd} ${totalDaysNeeded}天后可用)</span>
                    </div>
                `;
            }
        } else {
            nextSellerHtml = `<span class="text-gray-500">暂无可用卖家，请先添加卖家</span>`;
        }

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

            <!-- Boost Status & Recommendation Panel -->
            <div class="card mb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-torn-dark to-torn-card border border-torn-border">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full bg-torn-gold/10 flex items-center justify-center text-torn-gold text-lg">
                        <i class="fas fa-rocket"></i>
                    </div>
                    <div>
                        <div class="text-xs text-gray-400 uppercase tracking-wider">当前 Boost 状态</div>
                        <div class="mt-1">${boostStatusHtml}</div>
                    </div>
                </div>
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full bg-torn-green/10 flex items-center justify-center text-torn-green text-lg">
                        <i class="fas fa-shopping-cart"></i>
                    </div>
                    <div>
                        <div class="text-xs text-gray-400 uppercase tracking-wider">下一次购买推荐 (低价/最快)</div>
                        <div class="mt-1">${nextSellerHtml}</div>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
                ${UI.kpiCard('fas fa-users', '跟踪卖家数', String(totalSellers), '已记录', 'accent')}
                ${UI.kpiCard('fas fa-bolt', '已购买Boost', String(totalBoostsPurchased), '总计', 'gold')}
                ${UI.kpiCard('fas fa-dollar-sign', '总花费', Utils.formatMoney(totalCostPaid), '已付款项', 'green')}
            </div>
            <div id="boost-seller-table" class="card mb-6"></div>
            <div id="boost-purchases-table" class="card"></div>
        `;
    },

    _bindEvents() {
        document.getElementById('boost-add-seller')?.addEventListener('click', () => this.showAddSellerModal());
        document.getElementById('boost-refresh')?.addEventListener('click', () => this.render());
        document.getElementById('recommended-buy-btn')?.addEventListener('click', (e) => {
            const id = Number(e.currentTarget.dataset.id);
            const seller = this.sellers.find(s => s.id === id);
            if (seller) this.buyBoost(seller);
        });
        this._renderSellerTable();
        this._renderPurchasesTable();
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
            { key: 'next_purchase', label: '下一次可买时间', sortable: true, render: (val) => {
                if (val === '0000-00-00') {
                    return '<span class="text-torn-green font-bold">立即</span>';
                }
                
                // Calculate days from today (local time)
                const now = new Date();
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                
                const parts = val.split('-');
                const target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                
                const diffTime = target - today;
                const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
                
                if (diffDays <= 0) {
                    return `<span class="text-gray-300">${val} (今天)</span>`;
                } else if (diffDays === 1) {
                    return `<span class="text-gray-400">${val} (明天)</span>`;
                } else if (diffDays === 2) {
                    return `<span class="text-gray-400">${val} (后天)</span>`;
                } else {
                    return `<span class="text-gray-400">${val} (${diffDays}天后)</span>`;
                }
            }},
            { key: 'lastPurchased', label: '上次购买', sortable: true },
            { key: 'notes', label: '备注', sortable: false },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = this.sellers.map(seller => {
            const remaining = (seller.total_points || 0) - (seller.points_used || 0);
            const boostsAvail = Math.max(0, Math.floor(remaining / BOOST_POINTS_PER_USE));
            const remainColor = remaining < BOOST_POINTS_PER_USE ? 'text-red-400' : 'text-torn-green';
            const lastPurchased = seller.last_purchased_at
              ? Utils.relativeTime(seller.last_purchased_at / 1000)
              : '-';

            let nextPurchaseDate = '0000-00-00';
            if (remaining < BOOST_POINTS_PER_USE) {
                const pointsNeeded = BOOST_POINTS_PER_USE - remaining;
                const daysNeeded = Math.ceil(pointsNeeded / BOOST_DAILY_REGEN);
                const now = new Date();
                const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysNeeded);
                const yyyy = targetDate.getFullYear();
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
                const dd = String(targetDate.getDate()).padStart(2, '0');
                nextPurchaseDate = `${yyyy}-${mm}-${dd}`;
            }

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
                price: Utils.formatMoney(Utils.normalizeBoostPrice(seller.price_per_boost)),
                remaining: `<span class="${remainColor}">${Utils.formatShort(remaining)}</span>`,
                boosts_avail: String(boostsAvail),
                next_purchase: nextPurchaseDate,
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

    _renderPurchasesTable() {
        const container = document.getElementById('boost-purchases-table');
        if (!container) return;

        const txs = this.boostTransactions || [];
        if (!txs.length) {
            container.innerHTML = `
                <h3 class="text-lg font-bold text-white mb-3 px-4 pt-4">
                    <i class="fas fa-receipt mr-2 text-torn-gold"></i>购买记录
                </h3>
                ${UI.emptyState('fas fa-receipt', '暂无 Boost 购买记录')}
            `;
            return;
        }

        const headers = [
            { key: 'date', label: '日期', sortable: true },
            { key: 'seller', label: '卖家', sortable: true },
            { key: 'amount', label: '金额', sortable: true },
            { key: 'note', label: '备注' },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = txs.map(tx => {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 1e12) ts *= 1000;
            return {
                id: tx.id,
                date: tx.date || (ts ? Utils.formatDateTime(ts) : '-'),
                seller: tx.player_name || `ID:${tx.player_id}`,
                amount: Utils.formatTransactionAmount(tx),
                note: tx.note || '—',
                actions: `<button class="btn btn-xs btn-secondary boost-del-purchase" data-tx-id="${tx.id}"><i class="fas fa-trash"></i></button>`
            };
        });

        container.innerHTML = `
            <div class="p-4">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-receipt mr-2 text-torn-gold"></i>购买记录 (${txs.length})
                </h3>
                ${UI.dataTable({ headers, rows, id: 'boost-purchases', sortable: true, emptyText: '暂无记录' })}
            </div>
        `;
        UI.initSortable('boost-purchases');

        container.querySelectorAll('.boost-del-purchase').forEach(btn => {
            btn.addEventListener('click', () => this._deletePurchase(Number(btn.dataset.txId)));
        });
    },

    async _deletePurchase(txId) {
        if (!txId) return;
        if (!confirm('删除此购买记录？将同步撤销卖家已消耗点数。')) return;
        await DB.delete('transactions', txId);
        await Utils.reconcileBoostSellersFromTransactions();
        Utils.toast('购买记录已删除', 'info');
        await this.render();
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
                    <textarea id="add-player-id" class="input" rows="3" placeholder="Torn玩家ID或profile链接&#10;例如: https://www.torn.com/profiles.php?XID=123456"></textarea>
                    <p class="text-gray-500 text-xs mt-1">支持粘贴多个链接或ID，用逗号、空格或换行分隔</p>
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">玩家名称</label>
                    <input id="add-player-name" class="input" type="text" placeholder="手动填写或粘贴链接自动获取">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">单价/Boost ($)</label>
                    <input id="add-price" class="input" type="text" placeholder="美元，支持 k/m 后缀">
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
                    <button id="add-save" class="btn btn-primary">确认添加</button>
                </div>
            </div>
        `;

        Utils.showModal(content);

        const idInput = content.querySelector('#add-player-id');
        const nameInput = content.querySelector('#add-player-name');

        // Auto-detect URL paste in ID field — extract ID and resolve name
        idInput.addEventListener('input', async () => {
            const value = idInput.value.trim();
            if (!value || !value.includes('torn.com/profiles.php')) return;
            const ids = this._parseURLIDs(value);
            if (ids.length === 1) {
                // Single profile URL — replace textarea with the resolved ID
                idInput.value = ids[0];
                const resolvedName = await this._resolvePlayerName(ids[0]);
                if (resolvedName && !nameInput.value.trim()) {
                    nameInput.value = resolvedName;
                    Utils.toast(`已识别玩家: ${resolvedName}`, 'info');
                }
            } else if (ids.length > 1) {
                Utils.toast(`检测到 ${ids.length} 个玩家链接，将批量添加`, 'info');
            }
        });

        content.querySelector('#add-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#add-save').addEventListener('click', async () => {
            const rawInput = idInput.value.trim();
            const playerName = nameInput.value.trim();
            const price = Utils.parseMoneyInput(content.querySelector('#add-price').value);
            const totalPoints = parseInt(content.querySelector('#add-total-points').value) || 0;
            const notes = content.querySelector('#add-notes').value.trim();

            if (!rawInput) {
                Utils.toast('请填写玩家ID或链接', 'error');
                return;
            }

            // Parse multiple IDs from input (supports URLs or plain numbers)
            const parsedIds = this._parseURLIDs(rawInput);
            if (!parsedIds.length) {
                Utils.toast('未检测到有效的玩家ID', 'error');
                return;
            }

            // Deduplicate within batch
            const uniqueIds = [...new Set(parsedIds)];

            let addedCount = 0;
            let skippedCount = 0;
            const skippedNames = [];

            for (const pid of uniqueIds) {
                // Check if seller already exists
                const exists = this.sellers.some(s => String(s.player_id) === String(pid));
                if (exists) {
                    skippedCount++;
                    const existing = this.sellers.find(s => String(s.player_id) === String(pid));
                    skippedNames.push(existing?.player_name || `ID:${pid}`);
                    continue;
                }

                // Resolve name: use provided name, or fetch from API
                let resolvedName = playerName;
                if (!resolvedName && rawInput.includes('torn.com/profiles.php')) {
                    resolvedName = await this._resolvePlayerName(pid);
                }
                if (!resolvedName) {
                    resolvedName = `ID:${pid}`;
                }

                await DB.put('boost_sellers', {
                    player_id: pid,
                    player_name: resolvedName,
                    price_per_boost: price,
                    total_points: totalPoints,
                    points_used: 0,
                    last_updated: Date.now(),
                    notes: notes
                });
                addedCount++;
            }

            // Result summary
            let msg = `成功添加 ${addedCount} 个卖家`;
            if (skippedCount > 0) {
                msg += `，跳过 ${skippedCount} 个已存在 (${skippedNames.join(', ')})`;
            }
            Utils.toast(msg, addedCount > 0 ? 'success' : 'warning');
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
                    <label class="text-gray-400 text-sm mb-1 block">单价/Boost ($)</label>
                    <input id="edit-price" class="input" type="text" value="${Utils.normalizeBoostPrice(seller.price_per_boost)}">
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">当前剩余点数</label>
                    <input id="edit-remaining" class="input" type="number" min="0" value="${(seller.total_points || 0) - (seller.points_used || 0)}">
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

        // Auto-detect profile URL in name field — resolve to actual name
        content.querySelector('#edit-name').addEventListener('input', async () => {
            const value = content.querySelector('#edit-name').value.trim();
            if (!value || !value.includes('torn.com/profiles.php')) return;
            const ids = this._parseURLIDs(value);
            if (ids.length >= 1) {
                const resolvedName = await this._resolvePlayerName(ids[0]);
                if (resolvedName) {
                    content.querySelector('#edit-name').value = resolvedName;
                    Utils.toast(`已获取玩家名称: ${resolvedName}`, 'info');
                }
            }
        });

        content.querySelector('#edit-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#edit-save').addEventListener('click', async () => {
            seller.player_name = content.querySelector('#edit-name').value.trim();
            seller.price_per_boost = Utils.parseMoneyInput(content.querySelector('#edit-price').value);
            const remainingPoints = parseInt(content.querySelector('#edit-remaining').value) || 0;
            seller.total_points = remainingPoints + (seller.points_used || 0);
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
        if (remaining < BOOST_POINTS_PER_USE) {
            Utils.toast('卖家点数不足，无法购买Boost', 'error');
            return;
        }

        const unitPrice = Utils.normalizeBoostPrice(seller.price_per_boost);
        if (!confirm(`确认从 ${seller.player_name} 购买1个Boost？\n价格: ${Utils.formatMoney(unitPrice)}`)) return;

        // Deduct BOOST_POINTS_PER_USE points from seller
        seller.points_used = (seller.points_used || 0) + BOOST_POINTS_PER_USE;
        seller.last_purchased_at = Date.now();
        seller.last_updated = seller.last_purchased_at;
        await DB.put('boost_sellers', seller);

        await DB.put('transactions', {
            player_id: seller.player_id,
            player_name: seller.player_name,
            date: Utils.todayKey(),
            timestamp: Date.now(),
            amount: unitPrice,
            category: 'boost',
            note: '购买Boost'
        });
        await Utils.reconcileBoostSellersFromTransactions();
        this.sellers = await DB.getAll('boost_sellers');

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
