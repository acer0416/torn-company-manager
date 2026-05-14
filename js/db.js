// IndexedDB wrapper for persistent storage
const DB = {
  db: null,
  DB_NAME: 'torn-company-manager',
  DB_VERSION: 5,

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Company snapshot history
        if (!db.objectStoreNames.contains('snapshots')) {
          const store = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date');
        }
        // Employee history
        if (!db.objectStoreNames.contains('employee_history')) {
          const store = db.createObjectStore('employee_history', { keyPath: 'id', autoIncrement: true });
          store.createIndex('player_id', 'player_id');
          store.createIndex('date', 'date');
        }
        // Stock price history
        if (!db.objectStoreNames.contains('stock_history')) {
          const store = db.createObjectStore('stock_history', { keyPath: 'id', autoIncrement: true });
          store.createIndex('item_name', 'item_name');
          store.createIndex('date', 'date');
        }
        // Financial transactions (fund transfers)
        if (!db.objectStoreNames.contains('transactions')) {
          const store = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date');
          store.createIndex('category', 'category');
          store.createIndex('player_id', 'player_id');
          store.createIndex('week_key', 'week_key', { unique: false });
        }
        // Employee notes
        if (!db.objectStoreNames.contains('employee_notes')) {
          db.createObjectStore('employee_notes', { keyPath: 'player_id' });
        }
        // Training records
        if (!db.objectStoreNames.contains('training_records')) {
          const store = db.createObjectStore('training_records', { keyPath: 'id', autoIncrement: true });
          store.createIndex('player_id', 'player_id');
          store.createIndex('date', 'date');
          store.createIndex('week', 'week');
        }
        // Training config
        if (!db.objectStoreNames.contains('training_config')) {
          db.createObjectStore('training_config', { keyPath: 'key' });
        }
        // Rehab monitoring records
        if (!db.objectStoreNames.contains('rehab_records')) {
          const store = db.createObjectStore('rehab_records', { keyPath: 'id', autoIncrement: true });
          store.createIndex('player_id', 'player_id');
          store.createIndex('date', 'date');
        }
        // Rehab config (monitoring settings)
        if (!db.objectStoreNames.contains('rehab_config')) {
          db.createObjectStore('rehab_config', { keyPath: 'player_id' });
        }
        // Boost sellers
        if (!db.objectStoreNames.contains('boost_sellers')) {
          const boostStore = db.createObjectStore('boost_sellers', { keyPath: 'id', autoIncrement: true });
          boostStore.createIndex('player_id', 'player_id');
        }
        // Company type data cache
        if (!db.objectStoreNames.contains('company_types')) {
          db.createObjectStore('company_types', { keyPath: 'type_id' });
        }
        // App settings
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        // Employee master list (for historical tracking)
        if (!db.objectStoreNames.contains('employees_master')) {
          db.createObjectStore('employees_master', { keyPath: 'player_id' });
        }
        // Tax weeks (v4)
        if (!db.objectStoreNames.contains('tax_weeks')) {
          var twStore = db.createObjectStore('tax_weeks', { keyPath: 'week_key' });
          twStore.createIndex('year', 'year', { unique: false });
        }
        // Tax carryover records (v4)
        if (!db.objectStoreNames.contains('tax_carryover')) {
          var tcStore = db.createObjectStore('tax_carryover', { keyPath: 'id', autoIncrement: true });
          tcStore.createIndex('from_week_key', 'from_week_key', { unique: false });
          tcStore.createIndex('to_week_key', 'to_week_key', { unique: false });
        }
        // Employee tax snapshots per week (v5)
        if (!db.objectStoreNames.contains('employee_tax')) {
          var etStore = db.createObjectStore('employee_tax', { keyPath: 'id', autoIncrement: true });
          etStore.createIndex('week_key', 'week_key', { unique: false });
          etStore.createIndex('player_id', 'player_id', { unique: false });
        }
        // Employee tax rate configs (v5)
        if (!db.objectStoreNames.contains('employee_tax_rates')) {
          db.createObjectStore('employee_tax_rates', { keyPath: 'player_id' });
        }
        // Add week_key index to existing transactions store (v3→v4 upgrade)
        if (db.objectStoreNames.contains('transactions')) {
          var txStore = e.target.transaction.objectStore('transactions');
          if (!txStore.indexNames.contains('week_key')) {
            txStore.createIndex('week_key', 'week_key', { unique: false });
          }
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // Generic CRUD helpers
  async put(storeName, data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  async get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  async clear(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  // Get all records matching an index value
  async getByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const idx = tx.objectStore(storeName).index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // Count records in store
  async count(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // Export all data
  async exportAll() {
    const stores = ['snapshots', 'employee_history', 'stock_history', 'transactions',
      'employee_notes', 'training_records', 'training_config', 'rehab_records',
      'rehab_config', 'boost_sellers', 'settings', 'employees_master',
      'tax_weeks', 'tax_carryover', 'employee_tax', 'employee_tax_rates'];
    const data = {};
    for (const store of stores) {
      data[store] = await this.getAll(store);
    }
    data._exportVersion = 1;
    data._exportDate = new Date().toISOString();
    return data;
  },

  // Import all data
  async importAll(data) {
    const stores = ['snapshots', 'employee_history', 'stock_history', 'transactions',
      'employee_notes', 'training_records', 'training_config', 'rehab_records',
      'rehab_config', 'boost_sellers', 'settings', 'employees_master',
      'tax_weeks', 'tax_carryover', 'employee_tax', 'employee_tax_rates'];
    for (const store of stores) {
      if (data[store] && data[store].length) {
        await this.clear(store);
        for (const item of data[store]) {
          await this.put(store, item);
        }
      }
    }
    // Auto-trigger migration if imported data is from older schema
    var schemaVer = await this.get('settings', 'schema_version');
    if (!schemaVer || schemaVer.value < 4) {
      console.log('[DB] Imported data needs migration, running migrateV3toV4...');
      await this.migrateV3toV4();
    }
  },
  // Migrate data from v3 to v4: calculate week_key for tax transactions,
  // initialize tax_weeks snapshots, and mark migration complete
  migrateV3toV4: async function() {
    // Migration lock check
    var lockEntry = await this.get('settings', 'migration_lock');
    if (lockEntry) {
      var lockAge = Date.now() - lockEntry.value;
      if (lockAge < 5 * 60 * 1000) {
        console.log('[DB] Migration locked, skipping');
        return;
      }
    }

    // Set migration lock
    await this.put('settings', { key: 'migration_lock', value: Date.now() });

    try {
      // Check if already migrated
      var schemaVer = await this.get('settings', 'schema_version');
      if (schemaVer && schemaVer.value >= 4) {
        console.log('[DB] Already migrated to v4');
        await this.delete('settings', 'migration_lock');
        return;
      }

      // Step A: Calculate week_key for old tax transactions
      var allTxs = await this.getAll('transactions');
      for (var i = 0; i < allTxs.length; i++) {
        var t = allTxs[i];
        if (t.category === 'tax' && !t.week_key) {
          if (t.timestamp && t.timestamp > 0) {
            // 归一化时间戳：毫秒 (>= 1e12) 直接用，秒 (< 1e12) 转毫秒
            var ts = t.timestamp >= 1e12 ? t.timestamp : t.timestamp * 1000;
            t.week_key = Utils.weekKey(new Date(ts));
          } else {
            t.week_key = '__unassigned__';
          }
          await this.put('transactions', t);
        }
      }

      // Step B: Initialize tax_weeks for weeks with data
      var weekKeys = {};
      for (var j = 0; j < allTxs.length; j++) {
        var tx = allTxs[j];
        if (tx.category === 'tax' && tx.week_key && tx.week_key !== '__unassigned__') {
          weekKeys[tx.week_key] = true;
        }
      }
      var wkList = Object.keys(weekKeys);
      for (var k = 0; k < wkList.length; k++) {
        var wk = wkList[k];
        var parts = wk.split('-W');
        await this.put('tax_weeks', {
          week_key: wk,
          year: parseInt(parts[0], 10),
          week_number: parseInt(parts[1], 10),
          start_date: 0,
          end_date: 0,
          tax_due: 0,
          tax_paid: 0,
          carryover_in: 0,
          carryover_out: 0,
          net_due: 0,
          balance: 0,
          employee_count: 0,
          status: 'closed',
          updated_at: Date.now(),
          calculated_at: Date.now()
        });
      }

      // Step C: Mark migration complete
      await this.put('settings', { key: 'schema_version', value: 4 });

      console.log('[DB] Migration v3→v4 complete');
    } finally {
      // Clear migration lock
      await this.delete('settings', 'migration_lock');
    }
  }
};
