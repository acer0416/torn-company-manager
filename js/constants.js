// 共享设置常量 — popup 和 service-worker 必须同步使用
const SETTINGS_KEYS = {
  API_KEY: 'apiKey',
  MONITORING_ENABLED: 'monitoringEnabled',
  CHECK_INTERVAL: 'checkInterval',
  REFRESH_INTERVAL: 'refreshInterval',
  NOTIFICATIONS_ENABLED: 'notificationsEnabled',
  AUTO_STOCK_FILL: 'autoStockFill'
};

// 存储表名常量（供 DataPage 等使用）
const ALL_STORES = [
  'snapshots', 'employee_history', 'stock_history', 'transactions',
  'employee_notes', 'training_records', 'training_config', 'tax_config',
  'rehab_records', 'rehab_config', 'boost_sellers', 'company_types',
  'settings', 'employees_master', 'tax_weeks', 'tax_carryover',
  'employee_tax', 'employee_tax_rates', 'merit_history',
  'train_fund_allocations', 'rehab_api_snapshots', 'talents',
  'industry_companies', 'industry_meta'
];

const TRAIN_CATEGORIES = [
  { value: 'defense', label: '防御' },
  { value: 'dexterity', label: '敏捷' },
  { value: 'speed', label: '速度' },
  { value: 'strength', label: '力量' },
  { value: 'working_stats', label: '工作属性' },
  { value: 'battle_stats', label: '战斗属性' },
  { value: 'other', label: '其他' }
];

// 训练规划常量
const TRAIN_PRIMARY_BONUS = 50;    // 每次训练主属性加成
const TRAIN_SECONDARY_BONUS = 25;  // 每次训练副属性加成

// Torn 教育课程 ID 常量
const EDUCATION_IDS = {
  BUS2110: 11,  // 公司管理 → 效率乘数 1.2
  BUS2700: 7,   // 定价策略 → 售价 +10%
  BUS2900: 9    // 产品管理 → 售价 +5%
};

// BUS2110 教育效率乘数
const BUS2110_EFFICIENCY_MULTIPLIER = 1.2;

// 教育定价加成
const EDUCATION_PRICING_BONUS = {
  BUS2700: 0.10,  // +10% 售价
  BUS2900: 0.05   // +5% 售价
};

// Boost 常量
const BOOST_POINTS_PER_USE = 250;   // 每次 Boost 消耗点数
const BOOST_DAILY_REGEN = 10;       // 每日点数再生量

// 训练上限
const MAX_DAILY_TRAINS = 20;        // 每日训练次数上限

// 默认训练价格（用户可配置，此为回退默认值）
const DEFAULT_TRAIN_PRICE = 50000;

// 39 种公司类型岗位数据（来自 Torn Wiki / TrainingManager）
// 结构: COMPANY_JOBS[companyTypeId] = { company_name, jobs: [...] }
// 每个 job: { name, primary_req_stat, primary_req_value, secondary_req_stat, secondary_req_value, primary_gain_stat, secondary_gain_stat }
const COMPANY_JOBS = {
  1: {
    company_name: "Hair Salon",
    jobs: [
      { name: "Stylist", primary_req_stat: "MAN", primary_req_value: 1500, secondary_req_stat: "END", secondary_req_value: 750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Colorist", primary_req_stat: "MAN", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Nail Technician", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "MAN", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Apprentice", primary_req_stat: "MAN", primary_req_value: 500, secondary_req_stat: "END", secondary_req_value: 250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Shampooist", primary_req_stat: "MAN", primary_req_value: 1000, secondary_req_stat: "END", secondary_req_value: 500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Senior Stylist", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 2500, secondary_req_stat: "INT", secondary_req_value: 1250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Aesthetician", primary_req_stat: "INT", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  2: {
    company_name: "Law Firm",
    jobs: [
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 5500, secondary_req_stat: "END", secondary_req_value: 2750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 22000, secondary_req_stat: "END", secondary_req_value: 11000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Consultant", primary_req_stat: "INT", primary_req_value: 33000, secondary_req_stat: "END", secondary_req_value: 16500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Secretary", primary_req_stat: "END", primary_req_value: 16500, secondary_req_stat: "INT", secondary_req_value: 8250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Assistant", primary_req_stat: "END", primary_req_value: 5500, secondary_req_stat: "INT", secondary_req_value: 2750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Attorney", primary_req_stat: "INT", primary_req_value: 11000, secondary_req_stat: "END", secondary_req_value: 5500, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  3: {
    company_name: "Flower Shop",
    jobs: [
      { name: "Florist", primary_req_stat: "END", primary_req_value: 1000, secondary_req_stat: "MAN", secondary_req_value: 500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Arranger", primary_req_stat: "INT", primary_req_value: 1000, secondary_req_stat: "MAN", secondary_req_value: 500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Apprentice", primary_req_stat: "END", primary_req_value: 500, secondary_req_stat: "MAN", secondary_req_value: 250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 500, secondary_req_stat: "END", secondary_req_value: 250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 2000, secondary_req_stat: "INT", secondary_req_value: 1000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "INT", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "INT" }
    ]
  },
  4: {
    company_name: "Car Dealership",
    jobs: [
      { name: "Training Adviser", primary_req_stat: "INT", primary_req_value: 63000, secondary_req_stat: "END", secondary_req_value: 31500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 42000, secondary_req_stat: "INT", secondary_req_value: 21000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Webmaster", primary_req_stat: "INT", primary_req_value: 42000, secondary_req_stat: "END", secondary_req_value: 21000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 31500, secondary_req_stat: "INT", secondary_req_value: 15750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Mechanic", primary_req_stat: "MAN", primary_req_value: 26500, secondary_req_stat: "END", secondary_req_value: 13250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Sales Executive", primary_req_stat: "INT", primary_req_value: 21000, secondary_req_stat: "END", secondary_req_value: 10500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 10500, secondary_req_stat: "END", secondary_req_value: 5250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Sales Apprentice", primary_req_stat: "INT", primary_req_value: 5500, secondary_req_stat: "END", secondary_req_value: 2750, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  5: {
    company_name: "Clothing Store",
    jobs: [
      { name: "Line Manager", primary_req_stat: "INT", primary_req_value: 6000, secondary_req_stat: "END", secondary_req_value: 3000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Store Manager", primary_req_stat: "END", primary_req_value: 4000, secondary_req_stat: "INT", secondary_req_value: 2000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketing Manager", primary_req_stat: "INT", primary_req_value: 4000, secondary_req_stat: "END", secondary_req_value: 2000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "INT", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Security Guard", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Salesperson", primary_req_stat: "INT", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Cashier", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "MAN", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1000, secondary_req_stat: "END", secondary_req_value: 500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Sales Trainee", primary_req_stat: "INT", primary_req_value: 500, secondary_req_stat: "END", secondary_req_value: 250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  6: {
    company_name: "Gun Shop",
    jobs: [
      { name: "Clerk", primary_req_stat: "END", primary_req_value: 7500, secondary_req_stat: "MAN", secondary_req_value: 3750, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Gunsmith", primary_req_stat: "MAN", primary_req_value: 15000, secondary_req_stat: "INT", secondary_req_value: 7500, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 4000, secondary_req_stat: "END", secondary_req_value: 2000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 15000, secondary_req_stat: "INT", secondary_req_value: 7500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 11500, secondary_req_stat: "INT", secondary_req_value: 5750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 15000, secondary_req_stat: "END", secondary_req_value: 7500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Instructor", primary_req_stat: "INT", primary_req_value: 22500, secondary_req_stat: "END", secondary_req_value: 11250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  7: {
    company_name: "Game Shop",
    jobs: [
      { name: "Clerk", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "MAN", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Game Advisor", primary_req_stat: "INT", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1500, secondary_req_stat: "END", secondary_req_value: 750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Store Manager", primary_req_stat: "END", primary_req_value: 6000, secondary_req_stat: "INT", secondary_req_value: 3000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 4500, secondary_req_stat: "INT", secondary_req_value: 2250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 6000, secondary_req_stat: "END", secondary_req_value: 3000, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  8: {
    company_name: "Candle Shop",
    jobs: [
      { name: "Chandler", primary_req_stat: "MAN", primary_req_value: 4500, secondary_req_stat: "INT", secondary_req_value: 2250, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Quality Control", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "INT", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 2500, secondary_req_stat: "INT", secondary_req_value: 1250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Salesperson", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "INT", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1000, secondary_req_stat: "END", secondary_req_value: 500, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  9: {
    company_name: "Toy Shop",
    jobs: [
      { name: "Sales Assistant", primary_req_stat: "END", primary_req_value: 5000, secondary_req_stat: "MAN", secondary_req_value: 2500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 2500, secondary_req_stat: "END", secondary_req_value: 1250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Store Manager", primary_req_stat: "END", primary_req_value: 10000, secondary_req_stat: "INT", secondary_req_value: 5000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Office Clerk", primary_req_stat: "END", primary_req_value: 7500, secondary_req_stat: "INT", secondary_req_value: 3750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketing Executive", primary_req_stat: "INT", primary_req_value: 10000, secondary_req_stat: "END", secondary_req_value: 5000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Training Advisor", primary_req_stat: "INT", primary_req_value: 15000, secondary_req_stat: "END", secondary_req_value: 7500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Stock Clerk", primary_req_stat: "MAN", primary_req_value: 4000, secondary_req_stat: "END", secondary_req_value: 2000, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  10: {
    company_name: "Adult Novelties",
    jobs: [
      { name: "Human Resources", primary_req_stat: "INT", primary_req_value: 12000, secondary_req_stat: "END", secondary_req_value: 6000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Sexpert", primary_req_stat: "INT", primary_req_value: 10000, secondary_req_stat: "END", secondary_req_value: 5000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Store Manager", primary_req_stat: "END", primary_req_value: 8000, secondary_req_stat: "INT", secondary_req_value: 4000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketing Manager", primary_req_stat: "INT", primary_req_value: 8000, secondary_req_stat: "END", secondary_req_value: 4000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 6000, secondary_req_stat: "INT", secondary_req_value: 3000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Sales Assistant", primary_req_stat: "END", primary_req_value: 4000, secondary_req_stat: "MAN", secondary_req_value: 2000, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  11: {
    company_name: "Cyber Cafe",
    jobs: [
      { name: "Cashier", primary_req_stat: "END", primary_req_value: 10000, secondary_req_stat: "INT", secondary_req_value: 5000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 5000, secondary_req_stat: "END", secondary_req_value: 2500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 20000, secondary_req_stat: "INT", secondary_req_value: 10000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 15000, secondary_req_stat: "INT", secondary_req_value: 7500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 20000, secondary_req_stat: "END", secondary_req_value: 10000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Teacher", primary_req_stat: "INT", primary_req_value: 30000, secondary_req_stat: "END", secondary_req_value: 15000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Administrator", primary_req_stat: "INT", primary_req_value: 20000, secondary_req_stat: "END", secondary_req_value: 10000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Technician", primary_req_stat: "INT", primary_req_value: 17500, secondary_req_stat: "MAN", secondary_req_value: 8750, primary_gain_stat: "INT", secondary_gain_stat: "MAN" }
    ]
  },
  12: {
    company_name: "Grocery Store",
    jobs: [
      { name: "Cashier", primary_req_stat: "END", primary_req_value: 6000, secondary_req_stat: "MAN", secondary_req_value: 3000, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Stock Clerk", primary_req_stat: "MAN", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 12000, secondary_req_stat: "INT", secondary_req_value: 6000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 9000, secondary_req_stat: "INT", secondary_req_value: 4500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 12000, secondary_req_stat: "END", secondary_req_value: 6000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 18000, secondary_req_stat: "END", secondary_req_value: 9000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Delivery Driver", primary_req_stat: "MAN", primary_req_value: 7500, secondary_req_stat: "END", secondary_req_value: 3750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cart Attendant", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  13: {
    company_name: "Theater",
    jobs: [
      { name: "Ticketing Agent", primary_req_stat: "END", primary_req_value: 20000, secondary_req_stat: "INT", secondary_req_value: 10000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Technician", primary_req_stat: "MAN", primary_req_value: 60000, secondary_req_stat: "INT", secondary_req_value: 30000, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Programmer", primary_req_stat: "INT", primary_req_value: 50000, secondary_req_stat: "END", secondary_req_value: 25000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Janitor", primary_req_stat: "MAN", primary_req_value: 20000, secondary_req_stat: "END", secondary_req_value: 10000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 80000, secondary_req_stat: "INT", secondary_req_value: 40000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 60000, secondary_req_stat: "INT", secondary_req_value: 30000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketing Manager", primary_req_stat: "INT", primary_req_value: 80000, secondary_req_stat: "END", secondary_req_value: 40000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Usher", primary_req_stat: "END", primary_req_value: 20000, secondary_req_stat: "MAN", secondary_req_value: 10000, primary_gain_stat: "END", secondary_gain_stat: "MAN" }
    ]
  },
  14: {
    company_name: "Sweet Shop",
    jobs: [
      { name: "Confectionist", primary_req_stat: "INT", primary_req_value: 2500, secondary_req_stat: "END", secondary_req_value: 1250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Packager", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "MAN", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1000, secondary_req_stat: "END", secondary_req_value: 500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 4000, secondary_req_stat: "INT", secondary_req_value: 2000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "INT", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 4000, secondary_req_stat: "END", secondary_req_value: 2000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Clerk", primary_req_stat: "END", primary_req_value: 2000, secondary_req_stat: "MAN", secondary_req_value: 1000, primary_gain_stat: "END", secondary_gain_stat: "MAN" }
    ]
  },
  15: {
    company_name: "Cruise Line",
    jobs: [
      { name: "Captain", primary_req_stat: "INT", primary_req_value: 154500, secondary_req_stat: "END", secondary_req_value: 77250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "First Officer", primary_req_stat: "INT", primary_req_value: 105000, secondary_req_stat: "END", secondary_req_value: 52500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Doctor", primary_req_stat: "INT", primary_req_value: 103000, secondary_req_stat: "END", secondary_req_value: 51500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Specialist", primary_req_stat: "INT", primary_req_value: 90000, secondary_req_stat: "END", secondary_req_value: 45000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Bosun", primary_req_stat: "END", primary_req_value: 74000, secondary_req_stat: "INT", secondary_req_value: 37000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 72000, secondary_req_stat: "END", secondary_req_value: 36000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Chef", primary_req_stat: "INT", primary_req_value: 64500, secondary_req_stat: "END", secondary_req_value: 32250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Engineer", primary_req_stat: "MAN", primary_req_value: 54500, secondary_req_stat: "INT", secondary_req_value: 27250, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 42000, secondary_req_stat: "INT", secondary_req_value: 21000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Steward", primary_req_stat: "END", primary_req_value: 41500, secondary_req_stat: "INT", secondary_req_value: 20750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bartender", primary_req_stat: "END", primary_req_value: 38500, secondary_req_stat: "MAN", secondary_req_value: 19250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Deckhand", primary_req_stat: "MAN", primary_req_value: 26000, secondary_req_stat: "END", secondary_req_value: 13000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Ticket Agent", primary_req_stat: "END", primary_req_value: 26000, secondary_req_stat: "INT", secondary_req_value: 13000, primary_gain_stat: "END", secondary_gain_stat: "INT" }
    ]
  },
  16: {
    company_name: "Television Network",
    jobs: [
      { name: "Producer", primary_req_stat: "INT", primary_req_value: 99000, secondary_req_stat: "END", secondary_req_value: 49500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Programmer", primary_req_stat: "INT", primary_req_value: 66000, secondary_req_stat: "END", secondary_req_value: 33000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Camera Operator", primary_req_stat: "INT", primary_req_value: 49500, secondary_req_stat: "MAN", secondary_req_value: 24750, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Sales Executive", primary_req_stat: "END", primary_req_value: 49500, secondary_req_stat: "INT", secondary_req_value: 24750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 33000, secondary_req_stat: "END", secondary_req_value: 16500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Attorney", primary_req_stat: "INT", primary_req_value: 132000, secondary_req_stat: "END", secondary_req_value: 66000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Secretary", primary_req_stat: "END", primary_req_value: 99000, secondary_req_stat: "INT", secondary_req_value: 49500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 132000, secondary_req_stat: "END", secondary_req_value: 66000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Writer", primary_req_stat: "INT", primary_req_value: 115500, secondary_req_stat: "END", secondary_req_value: 57750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Stagehand", primary_req_stat: "MAN", primary_req_value: 33000, secondary_req_stat: "END", secondary_req_value: 16500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Anchor", primary_req_stat: "INT", primary_req_value: 132000, secondary_req_stat: "END", secondary_req_value: 66000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Reporter", primary_req_stat: "INT", primary_req_value: 82500, secondary_req_stat: "END", secondary_req_value: 41250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  18: {
    company_name: "Zoo",
    jobs: [
      { name: "Zoo Keeper", primary_req_stat: "MAN", primary_req_value: 58000, secondary_req_stat: "END", secondary_req_value: 29000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Animal Trainer", primary_req_stat: "INT", primary_req_value: 72500, secondary_req_stat: "MAN", secondary_req_value: 36250, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Aquarist", primary_req_stat: "END", primary_req_value: 58000, secondary_req_stat: "INT", secondary_req_value: 29000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Intern", primary_req_stat: "MAN", primary_req_value: 14500, secondary_req_stat: "END", secondary_req_value: 7250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 116000, secondary_req_stat: "INT", secondary_req_value: 58000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 87000, secondary_req_stat: "INT", secondary_req_value: 43500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Photographer", primary_req_stat: "INT", primary_req_value: 116000, secondary_req_stat: "END", secondary_req_value: 58000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Consultant", primary_req_stat: "INT", primary_req_value: 174000, secondary_req_stat: "END", secondary_req_value: 87000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Veterinarian", primary_req_stat: "INT", primary_req_value: 116000, secondary_req_stat: "MAN", secondary_req_value: 58000, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Cashier", primary_req_stat: "END", primary_req_value: 29000, secondary_req_stat: "INT", secondary_req_value: 14500, primary_gain_stat: "END", secondary_gain_stat: "INT" }
    ]
  },
  19: {
    company_name: "Firework Stand",
    jobs: [
      { name: "Salesperson", primary_req_stat: "END", primary_req_value: 1000, secondary_req_stat: "INT", secondary_req_value: 500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Pyrotechnician", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "INT", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Picker Packer", primary_req_stat: "MAN", primary_req_value: 500, secondary_req_stat: "END", secondary_req_value: 250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 2000, secondary_req_stat: "INT", secondary_req_value: 1000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "INT", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Advertising Manager", primary_req_stat: "INT", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  20: {
    company_name: "Property Broker",
    jobs: [
      { name: "Property Broker", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "INT", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Valuation Specialist", primary_req_stat: "INT", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Associate Broker", primary_req_stat: "END", primary_req_value: 500, secondary_req_stat: "INT", secondary_req_value: 250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1000, secondary_req_stat: "END", secondary_req_value: 500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Team Manager", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "INT", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 2500, secondary_req_stat: "INT", secondary_req_value: 1250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Graphic Designer", primary_req_stat: "INT", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Broker Support", primary_req_stat: "INT", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  21: {
    company_name: "Furniture Store",
    jobs: [
      { name: "Sales Clerk", primary_req_stat: "END", primary_req_value: 6500, secondary_req_stat: "INT", secondary_req_value: 3250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Delivery Driver", primary_req_stat: "MAN", primary_req_value: 8000, secondary_req_stat: "END", secondary_req_value: 4000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Apprentice", primary_req_stat: "END", primary_req_value: 1500, secondary_req_stat: "INT", secondary_req_value: 750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 3500, secondary_req_stat: "END", secondary_req_value: 1750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 13000, secondary_req_stat: "INT", secondary_req_value: 6500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 10000, secondary_req_stat: "INT", secondary_req_value: 5000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 13000, secondary_req_stat: "END", secondary_req_value: 6500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 19500, secondary_req_stat: "END", secondary_req_value: 9750, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  22: {
    company_name: "Gas Station",
    jobs: [
      { name: "Attendant", primary_req_stat: "END", primary_req_value: 26000, secondary_req_stat: "INT", secondary_req_value: 13000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 17500, secondary_req_stat: "END", secondary_req_value: 8750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 60000, secondary_req_stat: "INT", secondary_req_value: 30000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 40000, secondary_req_stat: "END", secondary_req_value: 20000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 70500, secondary_req_stat: "END", secondary_req_value: 35250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  23: {
    company_name: "Music Store",
    jobs: [
      { name: "Sales Assistant", primary_req_stat: "END", primary_req_value: 3500, secondary_req_stat: "INT", secondary_req_value: 1750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Musician", primary_req_stat: "INT", primary_req_value: 9000, secondary_req_stat: "MAN", secondary_req_value: 4500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Sales Apprentice", primary_req_stat: "END", primary_req_value: 1000, secondary_req_stat: "INT", secondary_req_value: 500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Supervisor", primary_req_stat: "END", primary_req_value: 7000, secondary_req_stat: "INT", secondary_req_value: 3500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 5500, secondary_req_stat: "INT", secondary_req_value: 2750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 10500, secondary_req_stat: "END", secondary_req_value: 5250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  24: {
    company_name: "Nightclub",
    jobs: [
      { name: "Bartender", primary_req_stat: "END", primary_req_value: 27000, secondary_req_stat: "MAN", secondary_req_value: 13500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Bouncer", primary_req_stat: "MAN", primary_req_value: 48000, secondary_req_stat: "END", secondary_req_value: 24000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Barback", primary_req_stat: "END", primary_req_value: 20500, secondary_req_stat: "MAN", secondary_req_value: 10250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 13500, secondary_req_stat: "END", secondary_req_value: 6750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 54000, secondary_req_stat: "INT", secondary_req_value: 27000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Personal Assistant", primary_req_stat: "END", primary_req_value: 40500, secondary_req_stat: "INT", secondary_req_value: 20250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Promoter", primary_req_stat: "INT", primary_req_value: 54000, secondary_req_stat: "END", secondary_req_value: 27000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 81000, secondary_req_stat: "END", secondary_req_value: 40500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Disk-jockey", primary_req_stat: "INT", primary_req_value: 40500, secondary_req_stat: "END", secondary_req_value: 20250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  25: {
    company_name: "Pub",
    jobs: [
      { name: "Bartender", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "MAN", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Bouncer", primary_req_stat: "MAN", primary_req_value: 6000, secondary_req_stat: "END", secondary_req_value: 3000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Waiter", primary_req_stat: "END", primary_req_value: 3000, secondary_req_stat: "MAN", secondary_req_value: 1500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 1500, secondary_req_stat: "END", secondary_req_value: 750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 6000, secondary_req_stat: "INT", secondary_req_value: 3000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 4500, secondary_req_stat: "INT", secondary_req_value: 2250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 9000, secondary_req_stat: "END", secondary_req_value: 4500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Promoter", primary_req_stat: "INT", primary_req_value: 6000, secondary_req_stat: "END", secondary_req_value: 3000, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  26: {
    company_name: "Gents Strip Club",
    jobs: [
      { name: "Stripper", primary_req_stat: "END", primary_req_value: 14500, secondary_req_stat: "MAN", secondary_req_value: 7250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Security", primary_req_stat: "MAN", primary_req_value: 29000, secondary_req_stat: "END", secondary_req_value: 14500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 7500, secondary_req_stat: "END", secondary_req_value: 3750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 29000, secondary_req_stat: "INT", secondary_req_value: 14500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 22000, secondary_req_stat: "INT", secondary_req_value: 11000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Photographer", primary_req_stat: "INT", primary_req_value: 29000, secondary_req_stat: "END", secondary_req_value: 14500, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  27: {
    company_name: "Restaurant",
    jobs: [
      { name: "Waiter", primary_req_stat: "END", primary_req_value: 2500, secondary_req_stat: "MAN", secondary_req_value: 1250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Sous Chef", primary_req_stat: "INT", primary_req_value: 4000, secondary_req_stat: "END", secondary_req_value: 2000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Head Chef", primary_req_stat: "END", primary_req_value: 5000, secondary_req_stat: "INT", secondary_req_value: 2500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Kitchen Assistant", primary_req_stat: "MAN", primary_req_value: 1500, secondary_req_stat: "END", secondary_req_value: 750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Head Waiter", primary_req_stat: "END", primary_req_value: 4000, secondary_req_stat: "INT", secondary_req_value: 2000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Line Cook", primary_req_stat: "INT", primary_req_value: 2500, secondary_req_stat: "MAN", secondary_req_value: 1250, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Chef", primary_req_stat: "INT", primary_req_value: 3000, secondary_req_stat: "MAN", secondary_req_value: 1500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Apprentice Chef", primary_req_stat: "INT", primary_req_value: 1500, secondary_req_stat: "MAN", secondary_req_value: 750, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Dishwasher", primary_req_stat: "MAN", primary_req_value: 1500, secondary_req_stat: "END", secondary_req_value: 750, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  28: {
    company_name: "Oil Rig",
    jobs: [
      { name: "Driller", primary_req_stat: "MAN", primary_req_value: 150000, secondary_req_stat: "INT", secondary_req_value: 75000, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Roughneck", primary_req_stat: "MAN", primary_req_value: 75000, secondary_req_stat: "END", secondary_req_value: 37500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Derrick Hand", primary_req_stat: "MAN", primary_req_value: 94000, secondary_req_stat: "END", secondary_req_value: 47000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Secretary", primary_req_stat: "END", primary_req_value: 112500, secondary_req_stat: "INT", secondary_req_value: 56250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Inspector", primary_req_stat: "INT", primary_req_value: 225000, secondary_req_stat: "END", secondary_req_value: 112500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Sales Executive", primary_req_stat: "INT", primary_req_value: 131500, secondary_req_stat: "END", secondary_req_value: 65750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Motor Hand", primary_req_stat: "MAN", primary_req_value: 112500, secondary_req_stat: "INT", secondary_req_value: 56250, primary_gain_stat: "MAN", secondary_gain_stat: "INT" }
    ]
  },
  29: {
    company_name: "Fitness Center",
    jobs: [
      { name: "Personal Trainer", primary_req_stat: "MAN", primary_req_value: 31000, secondary_req_stat: "END", secondary_req_value: 15500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Swimming Instructor", primary_req_stat: "END", primary_req_value: 46500, secondary_req_stat: "MAN", secondary_req_value: 23250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Lifeguard", primary_req_stat: "END", primary_req_value: 39000, secondary_req_stat: "MAN", secondary_req_value: 19500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 15500, secondary_req_stat: "END", secondary_req_value: 7750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 62000, secondary_req_stat: "INT", secondary_req_value: 31000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 10000, secondary_req_stat: "INT", secondary_req_value: 5000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 62000, secondary_req_stat: "END", secondary_req_value: 31000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Human Resources", primary_req_stat: "END", primary_req_value: 46500, secondary_req_stat: "INT", secondary_req_value: 23250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Nutritionist", primary_req_stat: "INT", primary_req_value: 54500, secondary_req_stat: "MAN", secondary_req_value: 27250, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Fitness Instructor", primary_req_stat: "MAN", primary_req_value: 46500, secondary_req_stat: "END", secondary_req_value: 23250, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  30: {
    company_name: "Mechanic Shop",
    jobs: [
      { name: "Technician", primary_req_stat: "MAN", primary_req_value: 8500, secondary_req_stat: "END", secondary_req_value: 4250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Apprentice Technician", primary_req_stat: "MAN", primary_req_value: 2000, secondary_req_stat: "END", secondary_req_value: 1000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 4500, secondary_req_stat: "END", secondary_req_value: 2250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 17000, secondary_req_stat: "INT", secondary_req_value: 8500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Receptionist", primary_req_stat: "END", primary_req_value: 13000, secondary_req_stat: "INT", secondary_req_value: 6500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Trainer", primary_req_stat: "INT", primary_req_value: 25500, secondary_req_stat: "END", secondary_req_value: 12750, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  31: {
    company_name: "Amusement Park",
    jobs: [
      { name: "Inspector", primary_req_stat: "INT", primary_req_value: 135000, secondary_req_stat: "END", secondary_req_value: 67500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 90000, secondary_req_stat: "INT", secondary_req_value: 45000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 90000, secondary_req_stat: "END", secondary_req_value: 45000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Security Guard", primary_req_stat: "MAN", primary_req_value: 79000, secondary_req_stat: "END", secondary_req_value: 39500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Mechanic", primary_req_stat: "MAN", primary_req_value: 67500, secondary_req_stat: "INT", secondary_req_value: 33750, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Accountant", primary_req_stat: "END", primary_req_value: 67500, secondary_req_stat: "INT", secondary_req_value: 33750, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Ride Attendant", primary_req_stat: "END", primary_req_value: 45000, secondary_req_stat: "INT", secondary_req_value: 22500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Entertainer", primary_req_stat: "MAN", primary_req_value: 34000, secondary_req_stat: "END", secondary_req_value: 17000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Ticket Agent", primary_req_stat: "END", primary_req_value: 22500, secondary_req_stat: "INT", secondary_req_value: 11250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Janitor", primary_req_stat: "MAN", primary_req_value: 22500, secondary_req_stat: "END", secondary_req_value: 11250, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  32: {
    company_name: "Lingerie Store",
    jobs: [
      { name: "Salesperson", primary_req_stat: "END", primary_req_value: 4500, secondary_req_stat: "INT", secondary_req_value: 2250, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 2500, secondary_req_stat: "END", secondary_req_value: 1250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Store Manager", primary_req_stat: "END", primary_req_value: 9000, secondary_req_stat: "INT", secondary_req_value: 4500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Lingerie Model", primary_req_stat: "INT", primary_req_value: 9000, secondary_req_stat: "END", secondary_req_value: 4500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Human Resources", primary_req_stat: "INT", primary_req_value: 13500, secondary_req_stat: "END", secondary_req_value: 6750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Trainee", primary_req_stat: "END", primary_req_value: 1000, secondary_req_stat: "INT", secondary_req_value: 500, primary_gain_stat: "END", secondary_gain_stat: "INT" }
    ]
  },
  33: {
    company_name: "Meat Warehouse",
    jobs: [
      { name: "Quality Controller", primary_req_stat: "INT", primary_req_value: 25000, secondary_req_stat: "MAN", secondary_req_value: 12500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Packer", primary_req_stat: "MAN", primary_req_value: 9500, secondary_req_stat: "END", secondary_req_value: 4750, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Apprentice Butcher", primary_req_stat: "MAN", primary_req_value: 3000, secondary_req_stat: "END", secondary_req_value: 1500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 6500, secondary_req_stat: "END", secondary_req_value: 3250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 25000, secondary_req_stat: "INT", secondary_req_value: 12500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Assistant", primary_req_stat: "END", primary_req_value: 19000, secondary_req_stat: "INT", secondary_req_value: 9500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Supervisor", primary_req_stat: "INT", primary_req_value: 37500, secondary_req_stat: "END", secondary_req_value: 18750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Butcher", primary_req_stat: "MAN", primary_req_value: 12500, secondary_req_stat: "END", secondary_req_value: 6250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Retailer", primary_req_stat: "INT", primary_req_value: 12500, secondary_req_stat: "END", secondary_req_value: 6250, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  34: {
    company_name: "Farm",
    jobs: [
      { name: "Harvester", primary_req_stat: "MAN", primary_req_value: 14000, secondary_req_stat: "END", secondary_req_value: 7000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Delivery Driver", primary_req_stat: "MAN", primary_req_value: 23000, secondary_req_stat: "END", secondary_req_value: 11500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Herdsperson", primary_req_stat: "MAN", primary_req_value: 18500, secondary_req_stat: "END", secondary_req_value: 9250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Farm Manager", primary_req_stat: "END", primary_req_value: 37000, secondary_req_stat: "INT", secondary_req_value: 18500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 28000, secondary_req_stat: "INT", secondary_req_value: 14000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Consultant", primary_req_stat: "INT", primary_req_value: 55500, secondary_req_stat: "END", secondary_req_value: 27750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Retailer", primary_req_stat: "INT", primary_req_value: 18500, secondary_req_stat: "END", secondary_req_value: 9250, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Dairy Farmer", primary_req_stat: "MAN", primary_req_value: 23000, secondary_req_stat: "END", secondary_req_value: 11500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Poultry Farmer", primary_req_stat: "MAN", primary_req_value: 18500, secondary_req_stat: "END", secondary_req_value: 9250, primary_gain_stat: "MAN", secondary_gain_stat: "END" }
    ]
  },
  35: {
    company_name: "Software Corporation",
    jobs: [
      { name: "Developer", primary_req_stat: "INT", primary_req_value: 24000, secondary_req_stat: "END", secondary_req_value: 12000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Tester", primary_req_stat: "INT", primary_req_value: 12000, secondary_req_stat: "END", secondary_req_value: 6000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Graphic Designer", primary_req_stat: "INT", primary_req_value: 18000, secondary_req_stat: "END", secondary_req_value: 9000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Apprentice", primary_req_stat: "INT", primary_req_value: 6000, secondary_req_stat: "END", secondary_req_value: 3000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 12000, secondary_req_stat: "END", secondary_req_value: 6000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Lead Developer", primary_req_stat: "END", primary_req_value: 48000, secondary_req_stat: "INT", secondary_req_value: 24000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Analyst", primary_req_stat: "END", primary_req_value: 36000, secondary_req_stat: "INT", secondary_req_value: 18000, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Marketer", primary_req_stat: "INT", primary_req_value: 48000, secondary_req_stat: "END", secondary_req_value: 24000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Consultant", primary_req_stat: "INT", primary_req_value: 72000, secondary_req_stat: "END", secondary_req_value: 36000, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  36: {
    company_name: "Ladies Strip Club",
    jobs: [
      { name: "Male Stripper", primary_req_stat: "END", primary_req_value: 14500, secondary_req_stat: "MAN", secondary_req_value: 7250, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Security", primary_req_stat: "MAN", primary_req_value: 29000, secondary_req_stat: "END", secondary_req_value: 14500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Cleaner", primary_req_stat: "MAN", primary_req_value: 8500, secondary_req_stat: "END", secondary_req_value: 4250, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Manager", primary_req_stat: "END", primary_req_value: 33000, secondary_req_stat: "INT", secondary_req_value: 16500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Bookkeeper", primary_req_stat: "END", primary_req_value: 25000, secondary_req_stat: "INT", secondary_req_value: 12500, primary_gain_stat: "END", secondary_gain_stat: "INT" },
      { name: "Photographer", primary_req_stat: "INT", primary_req_value: 33000, secondary_req_stat: "END", secondary_req_value: 16500, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  37: {
    company_name: "Private Security Firm",
    jobs: [
      { name: "Security Contractor", primary_req_stat: "MAN", primary_req_value: 70000, secondary_req_stat: "END", secondary_req_value: 35000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Team Leader", primary_req_stat: "MAN", primary_req_value: 110000, secondary_req_stat: "END", secondary_req_value: 55000, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Defence Consultant", primary_req_stat: "INT", primary_req_value: 135000, secondary_req_stat: "END", secondary_req_value: 67500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Spokesperson", primary_req_stat: "INT", primary_req_value: 80000, secondary_req_stat: "END", secondary_req_value: 40000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Company Liaison", primary_req_stat: "END", primary_req_value: 115000, secondary_req_stat: "INT", secondary_req_value: 57500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Chief Strategist", primary_req_stat: "INT", primary_req_value: 165000, secondary_req_stat: "END", secondary_req_value: 82500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Reconnaissance", primary_req_stat: "MAN", primary_req_value: 80000, secondary_req_stat: "INT", secondary_req_value: 40000, primary_gain_stat: "MAN", secondary_gain_stat: "INT" },
      { name: "Disposal Engineer", primary_req_stat: "INT", primary_req_value: 85000, secondary_req_stat: "END", secondary_req_value: 42500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Armourer", primary_req_stat: "END", primary_req_value: 80000, secondary_req_stat: "MAN", secondary_req_value: 40000, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Medic", primary_req_stat: "INT", primary_req_value: 90000, secondary_req_stat: "END", secondary_req_value: 45000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Comms Engineer", primary_req_stat: "INT", primary_req_value: 85000, secondary_req_stat: "END", secondary_req_value: 42500, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  38: {
    company_name: "Mining Corporation",
    jobs: [
      { name: "Sales Executive", primary_req_stat: "INT", primary_req_value: 83000, secondary_req_stat: "END", secondary_req_value: 41500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Mill Operator", primary_req_stat: "MAN", primary_req_value: 75000, secondary_req_stat: "END", secondary_req_value: 37500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Production Foreman", primary_req_stat: "END", primary_req_value: 79000, secondary_req_stat: "MAN", secondary_req_value: 39500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Mine Engineer", primary_req_stat: "INT", primary_req_value: 81000, secondary_req_stat: "END", secondary_req_value: 40500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Electrician", primary_req_stat: "END", primary_req_value: 78000, secondary_req_stat: "MAN", secondary_req_value: 39000, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Safety Inspector", primary_req_stat: "INT", primary_req_value: 95000, secondary_req_stat: "MAN", secondary_req_value: 47500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Site Manager", primary_req_stat: "INT", primary_req_value: 97000, secondary_req_stat: "END", secondary_req_value: 48750, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Secretary", primary_req_stat: "END", primary_req_value: 78000, secondary_req_stat: "INT", secondary_req_value: 39000, primary_gain_stat: "END", secondary_gain_stat: "INT" }
    ]
  },
  39: {
    company_name: "Detective Agency",
    jobs: [
      { name: "Private Investigator", primary_req_stat: "INT", primary_req_value: 45500, secondary_req_stat: "MAN", secondary_req_value: 22500, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Trainee Investigator", primary_req_stat: "INT", primary_req_value: 28000, secondary_req_stat: "MAN", secondary_req_value: 14000, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Secretary", primary_req_stat: "END", primary_req_value: 25000, secondary_req_stat: "MAN", secondary_req_value: 12500, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Intelligence Analyst", primary_req_stat: "INT", primary_req_value: 58000, secondary_req_stat: "END", secondary_req_value: 29000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Surveillance", primary_req_stat: "INT", primary_req_value: 52000, secondary_req_stat: "MAN", secondary_req_value: 26000, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Chief Investigator", primary_req_stat: "INT", primary_req_value: 80000, secondary_req_stat: "MAN", secondary_req_value: 40000, primary_gain_stat: "INT", secondary_gain_stat: "MAN" },
      { name: "Client Liaison", primary_req_stat: "INT", primary_req_value: 62000, secondary_req_stat: "END", secondary_req_value: 31000, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  },
  40: {
    company_name: "Logistics Management",
    jobs: [
      { name: "Lumper", primary_req_stat: "MAN", primary_req_value: 45000, secondary_req_stat: "END", secondary_req_value: 22500, primary_gain_stat: "MAN", secondary_gain_stat: "END" },
      { name: "Driver", primary_req_stat: "END", primary_req_value: 57500, secondary_req_stat: "MAN", secondary_req_value: 28750, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Forklift Operator", primary_req_stat: "END", primary_req_value: 60000, secondary_req_stat: "MAN", secondary_req_value: 30000, primary_gain_stat: "END", secondary_gain_stat: "MAN" },
      { name: "Transport Coordinator", primary_req_stat: "INT", primary_req_value: 85000, secondary_req_stat: "END", secondary_req_value: 42500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Warehouse Manager", primary_req_stat: "INT", primary_req_value: 115000, secondary_req_stat: "END", secondary_req_value: 57500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Shift Manager", primary_req_stat: "INT", primary_req_value: 90000, secondary_req_stat: "END", secondary_req_value: 45000, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Supply Chain Manager", primary_req_stat: "INT", primary_req_value: 125000, secondary_req_stat: "END", secondary_req_value: 62500, primary_gain_stat: "INT", secondary_gain_stat: "END" },
      { name: "Procurement Manager", primary_req_stat: "INT", primary_req_value: 140000, secondary_req_stat: "END", secondary_req_value: 70000, primary_gain_stat: "INT", secondary_gain_stat: "END" }
    ]
  }
};

window.TRAIN_CATEGORIES = TRAIN_CATEGORIES;
window.COMPANY_JOBS = COMPANY_JOBS;
window.TRAIN_PRIMARY_BONUS = TRAIN_PRIMARY_BONUS;
window.TRAIN_SECONDARY_BONUS = TRAIN_SECONDARY_BONUS;
window.EDUCATION_IDS = EDUCATION_IDS;
window.BUS2110_EFFICIENCY_MULTIPLIER = BUS2110_EFFICIENCY_MULTIPLIER;
window.EDUCATION_PRICING_BONUS = EDUCATION_PRICING_BONUS;
window.BOOST_POINTS_PER_USE = BOOST_POINTS_PER_USE;
window.BOOST_DAILY_REGEN = BOOST_DAILY_REGEN;
window.MAX_DAILY_TRAINS = MAX_DAILY_TRAINS;
window.DEFAULT_TRAIN_PRICE = DEFAULT_TRAIN_PRICE;
