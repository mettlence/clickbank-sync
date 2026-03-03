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
    baseURL: 'https://api.clickbank.com/rest/1.3',
    vendor: process.env.CLICKBANK_VENDOR || 'SABRINAPSY'
  },
  productId: process.env.PRODUCT_ID || 'SPR-OB2',
  products: {
    subscription: ['SPR-OB1', 'SPR-OB2'],
    oneTime: ['abdt-basic', 'abdt-advanced', 'SSR', 'SSR-D', 'dhr', 'dhr-d'] // Add your one-time product IDs
  }
};

async function fetchClickBankOrders(startDate, endDate, type) {
  const auth = `${config.clickbank.clerkKey}:${config.clickbank.devKey}`;
  const url = `${config.clickbank.baseURL}/orders2/list`;
  
  let allOrders = [];
  let page = 1;
  let hasMorePages = true;
  
  while (hasMorePages) {
    const params = {
      startDate,
      endDate,
      type,
      role: 'VENDOR',
      vendor: config.clickbank.vendor
      // No 'item' parameter - fetch all products
    };

    try {
      console.log(`  Fetching ${type} page ${page}...`);
      
      const response = await axios.get(url, {
        params,
        headers: {
          'Authorization': auth,
          'Accept': 'application/json',
          'Page': page.toString()  // ✅ Pass page number in HEADER
        }
      });
      
      const orderData = response.data?.orderData;
      const orders = Array.isArray(orderData) ? orderData : [];
      
      if (orders.length > 0) {
        allOrders = allOrders.concat(orders);
        console.log(`  Page ${page}: Found ${orders.length} orders (Total: ${allOrders.length})`);
      }
      
      // ✅ Check status code: 206 = more pages, 200 = last page
      if (response.status === 206) {
        hasMorePages = true;
        page++;
      } else if (response.status === 200) {
        hasMorePages = false;
        console.log(`  ✓ Completed: ${allOrders.length} total ${type} orders`);
      } else {
        hasMorePages = false;
      }
      
    } catch (error) {
      console.error(`ClickBank API Error (${type}, page ${page}):`, error.response?.data || error.message);
      hasMorePages = false;
    }
  }
  
  return allOrders;
}

function transformOrder(order, lineItem) {  // ✅ Pass lineItem as parameter
  // Helper functions (keep as is)
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
  
  // Extract siteSource
  const getSiteSource = () => {
    const vendorVars = order.vendorVariables?.item;
    if (!Array.isArray(vendorVars)) return null;
    const siteSourceVar = vendorVars.find(v => v.name === 'siteSource');
    return siteSourceVar?.value || null;
  };
  
  // Determine status
  let status = getValue(lineItem.status);
  if (!status) {
    const statusMap = {
      'RFND': 'REFUNDED',
      'CGBK': 'CHARGEBACK',
      'CANCEL-REBILL': 'CANCELED',
      'BILL': 'ACTIVE',
      'SALE': lineItem.recurring === 'true' ? 'ACTIVE' : 'COMPLETED'
    };
    status = statusMap[order.transactionType] || 'UNKNOWN';
  }
  
  const isRecurring = lineItem.recurring === 'true';
  
  return {
    receipt: order.receipt,
    productId: lineItem.itemNo || 'UNKNOWN',
    customerId: order.email,
    customerEmail: order.email,
    transactionType: order.transactionType,
    amount: parseNum(lineItem.accountAmount, 0),
    currency: order.currency,
    orderDate: parseDate(order.transactionTime) || new Date(),
    subscriptionStatus: isRecurring ? status : null,
    isRecurring: isRecurring,
    processedPayments: isRecurring ? parseIntSafe(lineItem.processedPayments, 0) : null,
    nextPaymentDate: isRecurring ? parseDate(lineItem.nextPaymentDate) : null,
    rebillAmount: isRecurring ? parseNum(lineItem.rebillAmount, 0) : null,
    siteSource: getSiteSource() == 'chatbot' ? 'vsl v1' : getSiteSource(),
    lineItemType: lineItem.lineItemType || 'STANDARD'
  };
}

function prepareRawOrder(order) {
  const lineItem = order.lineItemData || {};
  
  return {
    receipt: order.receipt,
    productId: lineItem.itemNo || 'UNKNOWN',
    transactionType: order.transactionType,
    orderDate: new Date(order.transactionTime),
    rawData: order // Store entire response
  };
}

async function syncOrdersByType(startDate, endDate, type) {
  console.log(`Fetching ${type} orders...`);
  
  const orders = await fetchClickBankOrders(startDate, endDate, type);
  console.log(`  Found ${orders.length} ${type} orders`);
  
  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  
  for (const order of orders) {
    try {
      // Handle lineItemData as array OR single object
      let lineItems = order.lineItemData;
      
      if (!Array.isArray(lineItems)) {
        lineItems = lineItems ? [lineItems] : [];
      }
      
      // Process each line item as a separate order
      for (const lineItem of lineItems) {
        const transformed = transformOrder(order, lineItem);
        
        console.log(`  Processing ${order.receipt} (${transformed.productId}) - ${order.transactionType} - ${transformed.isRecurring ? 'Recurring' : 'One-time'} - ${transformed.lineItemType}`);
        
        const result = await Order.updateOne(
          { 
            receipt: transformed.receipt,
            transactionType: transformed.transactionType,
            productId: transformed.productId
          },
          { $set: transformed },
          { upsert: true }
        );
        
        if (result.upsertedCount > 0) {
          inserted++;
          console.log(`    ✓ Inserted`);
        } else if (result.modifiedCount > 0) {
          updated++;
          console.log(`    ✓ Updated`);
        } else {
          console.log(`    = No change`);
        }
        
        processed++;
      }
      
      // ✅ MOVE THIS OUTSIDE THE LINE ITEM LOOP
      // Store raw order ONCE per receipt (not per line item)
      const rawOrder = prepareRawOrder(order);
      await OrderRaw.updateOne(
        { 
          receipt: rawOrder.receipt,
          transactionType: rawOrder.transactionType  // ✅ Add transactionType to make it unique
        },
        { $set: rawOrder },
        { upsert: true }
      );
      
    } catch (err) {
      failed++;
      console.error(`  ✗ Error processing ${order.receipt}:`, err.message);
      console.error(`    Full error:`, err);
    }
  }
  
  console.log(`  Summary: ${inserted} inserted, ${updated} updated, ${failed} failed\n`);
  return { total: orders.length, processed, inserted, updated, failed };
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

function getMonthRange(monthStr) {
  const start = new Date(monthStr + '-01');
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

async function main() {
  try {
    await mongoose.connect(config.mongodb);
    console.log('✓ Connected to MongoDB');
    
    const now = new Date();
    
    // Accept month parameter from command line
    const customMonth = process.argv[2]; // e.g., "2025-11"
    
    let lastMonthStr, thisMonthStr;
    
    if (customMonth) {
      // Sync only the specified month
      lastMonthStr = customMonth;
      thisMonthStr = customMonth;
      console.log(`Syncing single month: ${customMonth}`);
    } else {
      // Default: sync last month + this month
      const lastMonth = new Date(now);
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
      thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    
    const lastMonthRange = getMonthRange(lastMonthStr);
    const thisMonthRange = getMonthRange(thisMonthStr);
    
    console.log('='.repeat(50));
    console.log('MONTHLY FULL SYNC');
    console.log('='.repeat(50));
    
    if (customMonth) {
      // Sync only one month
      const startDate = `${lastMonthStr}-01`;
      const monthEnd = new Date(lastMonthRange.end);
      monthEnd.setDate(monthEnd.getDate() - 1);
      const endDate = `${lastMonthStr}-${String(monthEnd.getDate()).padStart(2, '0')}`;
      
      console.log(`\nSyncing: ${startDate} to ${endDate}`);
      await syncOrders(startDate, endDate);
    } else {
      // Sync both months
      const lastMonthStart = `${lastMonthStr}-01`;
      const lastMonthEnd = new Date(lastMonthRange.end);
      lastMonthEnd.setDate(lastMonthEnd.getDate() - 1);
      const lastMonthEndStr = `${lastMonthStr}-${String(lastMonthEnd.getDate()).padStart(2, '0')}`;
      
      const thisMonthStart = `${thisMonthStr}-01`;
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      console.log('\nLAST MONTH:', lastMonthStart, 'to', lastMonthEndStr);
      await syncOrders(lastMonthStart, lastMonthEndStr);
      
      console.log('\nTHIS MONTH:', thisMonthStart, 'to', today);
      await syncOrders(thisMonthStart, today);
    }
    
    console.log('\n✅ Monthly sync completed successfully');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

main();