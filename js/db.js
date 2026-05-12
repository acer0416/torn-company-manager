// IndexedDB wrapper for persistent storage
const DB = {
  db: null,
  DB_NAME: 'torn-company-manager',
  DB_VERSION: 3,

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
      'rehab_config', 'boost_sellers', 'settings', 'employees_master'];
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
      'rehab_config', 'boost_sellers', 'settings', 'employees_master'];
    for (const store of stores) {
      if (data[store] && data[store].length) {
        await this.clear(store);
        for (const item of data[store]) {
          await this.put(store, item);
        }
      }
    }
  }
};
