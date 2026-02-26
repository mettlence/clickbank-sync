require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Order = require('./models/Order');
const OrderRaw = require('./models/OrderRaw');

const config = {
  mongodb: process.env.MONGODB_URI,
  clickbank: {
    clerkKey: process.env.CLICKBANK_CLERK_KEY,
    devKey: process.env.CLICKBANK_DEV_KEY,
    baseURL: 'https://api.clickbank.com/rest/1.3'
  },
  productId: process.env.PRODUCT_ID || 'SPR-OB2'
};

async function fetchClickBankOrders(startDate, endDate, type) {
  const auth = `${config.clickbank.clerkKey}:${config.clickbank.devKey}`;
  const url = `${config.clickbank.baseURL}/orders2/list`;
  
  const params = {
    startDate,
    endDate,
    item: config.productId,
    type,
    role: 'VENDOR'
  };

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        'Authorization': auth,
        'Accept': 'application/json'
      }
    });
    
    const orderData = response.data?.orderData;
    return Array.isArray(orderData) ? orderData : [];
  } catch (error) {
    console.error(`ClickBank API Error (${type}):`, error.response?.data || error.message);
    return [];
  }
}

function transformOrder(order) {
  const lineItem = order.lineItemData || {};
  
  const isNil = (val) => val && typeof val === 'object' && val['@nil'] === 'true';
  const getValue = (val, defaultVal = null) => isNil(val) ? defaultVal : val;
  const parseDate = (dateStr) => {
    if (!dateStr || isNil(dateStr)) return null;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  };
  const parseNum = (val, defaultVal = 0) => {
    if (isNil(val)) return defaultVal;
    const num = parseFloat(val);
    return isNaN(num) ? defaultVal : num;
  };
  const parseIntSafe = (val, defaultVal = 0) => {
    if (isNil(val)) return defaultVal;
    const num = Number.parseInt(val);
    return isNaN(num) ? defaultVal : num;
  };
  
  let status = getValue(lineItem.status);
  if (!status) {
    if (order.transactionType === 'RFND') status = 'REFUNDED';
    else if (order.transactionType === 'CGBK') status = 'CHARGEBACK';
    else status = 'UNKNOWN';
  }
  
  return {
    receipt: order.receipt,
    productId: lineItem.itemNo || config.productId,
    customerId: order.email,
    customerEmail: order.email,
    transactionType: order.transactionType,
    amount: parseNum(order.totalOrderAmount, 0),
    currency: order.currency,
    orderDate: parseDate(order.transactionTime) || new Date(),
    subscriptionStatus: status,
    isRecurring: lineItem.recurring === 'true',
    processedPayments: parseIntSafe(lineItem.processedPayments, 0),
    nextPaymentDate: parseDate(lineItem.nextPaymentDate),
    rebillAmount: parseNum(lineItem.rebillAmount, 0)
  };
}

function prepareRawOrder(order) {
  const lineItem = order.lineItemData || {};
  return {
    receipt: order.receipt,
    productId: lineItem.itemNo || config.productId,
    transactionType: order.transactionType,
    orderDate: new Date(order.transactionTime),
    rawData: order
  };
}

async function syncOrdersByType(startDate, endDate, type) {
  console.log(`Fetching ${type} orders...`);
  
  const orders = await fetchClickBankOrders(startDate, endDate, type);
  console.log(`  Found ${orders.length} ${type} orders`);
  
  let processed = 0;
  
  for (const order of orders) {
    try {
      const transformed = transformOrder(order);
      await Order.updateOne(
        { receipt: transformed.receipt },
        { $set: transformed },
        { upsert: true }
      );
      
      const rawOrder = prepareRawOrder(order);
      await OrderRaw.updateOne(
        { receipt: rawOrder.receipt },
        { $set: rawOrder },
        { upsert: true }
      );
      
      processed++;
    } catch (err) {
      console.error(`  Error processing ${order.receipt}:`, err.message);
    }
  }
  
  return { total: orders.length, processed };
}

async function syncOrders(startDate, endDate) {
  console.log(`\nSyncing orders from ${startDate} to ${endDate}`);
  
  const types = ['SALE', 'BILL', 'RFND', 'CGBK', 'CANCEL-REBILL'];
  let totalOrders = 0;
  
  for (const type of types) {
    const result = await syncOrdersByType(startDate, endDate, type);
    totalOrders += result.processed;
  }
  
  console.log(`Total processed: ${totalOrders} orders\n`);
  return totalOrders;
}

async function main() {
  try {
    await mongoose.connect(config.mongodb);
    console.log('✓ Connected to MongoDB');
    
    const now = new Date();
    
    // Fetch last 3 days to catch any retroactive updates
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    
    const startDate = `${threeDaysAgo.getFullYear()}-${String(threeDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(threeDaysAgo.getDate()).padStart(2, '0')}`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    console.log('='.repeat(50));
    console.log('DAILY INCREMENTAL SYNC');
    console.log('Date range:', startDate, 'to', today);
    console.log('='.repeat(50));
    
    await syncOrders(startDate, today);
    
    console.log('✅ Daily sync completed successfully');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

main();