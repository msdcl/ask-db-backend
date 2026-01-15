/**
 * E-Commerce Domain Glossary
 * Maps business terms to SQL calculations and required tables
 */

export const ECOMMERCE_GLOSSARY = {
  // Revenue & Sales Metrics
  gmv: {
    name: 'Gross Merchandise Value',
    calculation: 'SUM(order_items.price * order_items.quantity)',
    alternateNames: ['gross merchandise value', 'total sales value'],
    tables: ['orders', 'order_items'],
    description: 'Total value of all merchandise sold',
  },
  revenue: {
    name: 'Revenue',
    calculation: 'SUM(orders.total_amount)',
    alternateNames: ['total revenue', 'sales revenue', 'income'],
    tables: ['orders'],
    description: 'Total revenue from orders',
  },
  aov: {
    name: 'Average Order Value',
    calculation: 'AVG(orders.total_amount)',
    alternateNames: ['average order value', 'avg order'],
    tables: ['orders'],
    description: 'Average value per order',
  },
  arpu: {
    name: 'Average Revenue Per User',
    calculation: 'SUM(orders.total_amount) / COUNT(DISTINCT orders.customer_id)',
    alternateNames: ['revenue per user', 'arpu'],
    tables: ['orders', 'customers'],
    description: 'Average revenue generated per customer',
  },

  // Order Metrics
  'order count': {
    name: 'Order Count',
    calculation: 'COUNT(DISTINCT orders.id)',
    alternateNames: ['number of orders', 'total orders', 'orders count'],
    tables: ['orders'],
  },
  'items sold': {
    name: 'Items Sold',
    calculation: 'SUM(order_items.quantity)',
    alternateNames: ['units sold', 'quantity sold', 'total items'],
    tables: ['order_items'],
  },

  // Customer Metrics
  'customer count': {
    name: 'Customer Count',
    calculation: 'COUNT(DISTINCT customers.id)',
    alternateNames: ['number of customers', 'total customers', 'user count'],
    tables: ['customers'],
  },
  'new customers': {
    name: 'New Customers',
    calculation: 'COUNT(DISTINCT customers.id) with first order in period',
    alternateNames: ['new users', 'first time buyers'],
    tables: ['customers', 'orders'],
  },
  'repeat customers': {
    name: 'Repeat Customers',
    calculation: 'customers with order_count > 1',
    alternateNames: ['returning customers', 'loyal customers'],
    tables: ['customers', 'orders'],
  },

  // Conversion Metrics
  'conversion rate': {
    name: 'Conversion Rate',
    calculation: '(COUNT(DISTINCT orders.id) / COUNT(DISTINCT sessions.id)) * 100',
    alternateNames: ['cvr', 'purchase rate'],
    tables: ['orders', 'sessions'],
    description: 'Percentage of sessions that result in orders',
  },
  'cart abandonment': {
    name: 'Cart Abandonment Rate',
    calculation: '((carts_created - orders_completed) / carts_created) * 100',
    alternateNames: ['abandoned carts', 'cart drop off'],
    tables: ['carts', 'orders'],
  },

  // Product Metrics
  'top selling': {
    name: 'Top Selling Products',
    calculation: 'ORDER BY SUM(order_items.quantity) DESC',
    alternateNames: ['best sellers', 'most sold', 'popular products'],
    tables: ['products', 'order_items'],
  },
  'top revenue': {
    name: 'Top Revenue Products',
    calculation: 'ORDER BY SUM(order_items.price * order_items.quantity) DESC',
    alternateNames: ['highest revenue', 'most profitable'],
    tables: ['products', 'order_items'],
  },

  // Time Periods
  mtd: {
    name: 'Month to Date',
    timeFilter: 'FROM start of current month TO today',
    alternateNames: ['this month', 'current month'],
  },
  ytd: {
    name: 'Year to Date',
    timeFilter: 'FROM start of current year TO today',
    alternateNames: ['this year', 'current year'],
  },
  qtd: {
    name: 'Quarter to Date',
    timeFilter: 'FROM start of current quarter TO today',
    alternateNames: ['this quarter', 'current quarter'],
  },
  wow: {
    name: 'Week over Week',
    comparison: 'Compare current week to previous week',
    alternateNames: ['weekly comparison', 'week on week'],
  },
  mom: {
    name: 'Month over Month',
    comparison: 'Compare current month to previous month',
    alternateNames: ['monthly comparison', 'month on month'],
  },
  yoy: {
    name: 'Year over Year',
    comparison: 'Compare to same period last year',
    alternateNames: ['yearly comparison', 'year on year'],
  },

  // Entity Mappings
  sku: {
    name: 'SKU',
    mapsTo: 'products.sku_code',
    alternateNames: ['product code', 'item code'],
  },
  customer: {
    name: 'Customer',
    mapsTo: 'customers',
    alternateNames: ['buyer', 'user', 'consumer', 'shopper'],
  },
  seller: {
    name: 'Seller',
    mapsTo: 'vendors',
    alternateNames: ['merchant', 'shop', 'store', 'vendor'],
  },
  product: {
    name: 'Product',
    mapsTo: 'products',
    alternateNames: ['item', 'goods', 'merchandise'],
  },
  order: {
    name: 'Order',
    mapsTo: 'orders',
    alternateNames: ['purchase', 'transaction', 'sale'],
  },
  category: {
    name: 'Category',
    mapsTo: 'categories',
    alternateNames: ['product category', 'type'],
  },
};

/**
 * Intent types for query classification
 */
export const INTENT_TYPES = {
  // Aggregation intents
  TOTAL: {
    name: 'Total/Sum',
    keywords: ['total', 'sum', 'overall', 'combined'],
    requiresAggregate: true,
    aggregateFunction: 'SUM',
  },
  COUNT: {
    name: 'Count',
    keywords: ['count', 'number of', 'how many', 'quantity'],
    requiresAggregate: true,
    aggregateFunction: 'COUNT',
  },
  AVERAGE: {
    name: 'Average',
    keywords: ['average', 'avg', 'mean', 'typical'],
    requiresAggregate: true,
    aggregateFunction: 'AVG',
  },

  // Ranking intents
  TOP_N: {
    name: 'Top N',
    keywords: ['top', 'best', 'highest', 'most', 'greatest'],
    requiresOrderBy: true,
    orderDirection: 'DESC',
    requiresLimit: true,
  },
  BOTTOM_N: {
    name: 'Bottom N',
    keywords: ['bottom', 'worst', 'lowest', 'least', 'smallest'],
    requiresOrderBy: true,
    orderDirection: 'ASC',
    requiresLimit: true,
  },
  RANKING: {
    name: 'Ranking',
    keywords: ['rank', 'ranking', 'leaderboard', 'standings'],
    requiresOrderBy: true,
    mayRequireWindowFunction: true,
  },

  // Trend intents
  TREND: {
    name: 'Trend/Time Series',
    keywords: ['trend', 'over time', 'history', 'daily', 'weekly', 'monthly', 'daywise'],
    requiresGroupBy: true,
    groupByType: 'time',
  },
  GROWTH: {
    name: 'Growth Rate',
    keywords: ['growth', 'increase', 'decrease', 'change', 'delta'],
    requiresComparison: true,
  },
  COMPARISON: {
    name: 'Comparison',
    keywords: ['compare', 'vs', 'versus', 'difference', 'between'],
    requiresGroupBy: true,
  },

  // Lookup intents
  FILTER: {
    name: 'Filter/Search',
    keywords: ['where', 'filter', 'only', 'specific', 'particular'],
    requiresWhere: true,
  },
  DETAIL: {
    name: 'Detail Lookup',
    keywords: ['details', 'information', 'info', 'about', 'show me'],
    isLookup: true,
  },
  LIST: {
    name: 'List',
    keywords: ['list', 'all', 'show', 'display', 'get'],
    isListing: true,
  },

  // Grouping intents
  BY_CATEGORY: {
    name: 'By Category/Group',
    keywords: ['by', 'per', 'each', 'every', 'group by', 'breakdown'],
    requiresGroupBy: true,
  },
};

/**
 * Entity patterns for extraction
 */
export const ENTITY_PATTERNS = {
  product: /\b(product|item|goods|sku|merchandise)\b/i,
  customer: /\b(customer|buyer|user|consumer|shopper)\b/i,
  order: /\b(order|purchase|transaction|sale)\b/i,
  category: /\b(category|categories|type|segment)\b/i,
  seller: /\b(seller|vendor|merchant|shop|store)\b/i,
  payment: /\b(payment|transaction|billing)\b/i,
  shipping: /\b(shipping|delivery|shipment)\b/i,
  inventory: /\b(inventory|stock|warehouse)\b/i,
  review: /\b(review|rating|feedback)\b/i,
  cart: /\b(cart|basket|checkout)\b/i,
};

/**
 * Time extraction patterns
 */
export const TIME_PATTERNS = {
  lastNDays: /last\s+(\d+)\s+days?/i,
  lastNWeeks: /last\s+(\d+)\s+weeks?/i,
  lastNMonths: /last\s+(\d+)\s+months?/i,
  lastNYears: /last\s+(\d+)\s+years?/i,
  thisWeek: /this\s+week/i,
  thisMonth: /this\s+month/i,
  thisYear: /this\s+year/i,
  lastWeek: /last\s+week/i,
  lastMonth: /last\s+month/i,
  lastYear: /last\s+year/i,
  yesterday: /yesterday/i,
  today: /today/i,
  dateRange: /from\s+(.+?)\s+to\s+(.+)/i,
  specificDate: /on\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i,
};
