// 共享设置常量 — popup 和 service-worker 必须同步使用
const SETTINGS_KEYS = {
  API_KEY: 'apiKey',
  MONITORING_ENABLED: 'monitoringEnabled',
  CHECK_INTERVAL: 'checkInterval',
  REFRESH_INTERVAL: 'refreshInterval',
  NOTIFICATIONS_ENABLED: 'notificationsEnabled'
};

// 存储表名常量（供 DataPage 等使用）
const ALL_STORES = [
  'snapshots', 'employee_history', 'stock_history', 'transactions',
  'employee_notes', 'training_records', 'training_config', 'tax_config',
  'rehab_records', 'rehab_config', 'boost_sellers', 'company_types',
  'settings', 'employees_master', 'tax_weeks', 'tax_carryover',
  'employee_tax', 'employee_tax_rates', 'merit_history'
];
