// verify-sync.js
require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Order = require('./models/Order');

const config = {
  mongodb: process.env.MONGODB_URI,
  clickbank: {
    clerkKey: process.env.CLICKBANK_CLERK_KEY,
    devKey: process.env.CLICKBANK_DEV_KEY,
    baseURL: 'https://api.clickbank.com/rest/1.3'
  }
};

async function fetchClickBankOrders(startDate, endDate, type, productId) {
  const auth = `${config.clickbank.clerkKey}:${config.clickbank.devKey}`;
  const url = `${config.clickbank.baseURL}/orders2/list`;
  
  const params = {
    startDate,
    endDate,
    item: productId,
    type,
    role: 'VENDOR'
  };

  const response = await axios.get(url, { params, headers: { 'Authorization': auth, 'Accept': 'application/json' } });
  return response.data?.orderData || [];
}

async function main() {
  await mongoose.connect(config.mongodb);
  console.log('✓ Connected to MongoDB\n');
  
  // Fetch from API
  const apiOrders = await fetchClickBankOrders('2025-12-01', '2025-12-31', 'SALE', 'SPR-OB2');
  console.log(`API returned: ${apiOrders.length} SPR-OB2 SALE orders`);
  
  const apiReceipts = apiOrders.map(o => o.receipt).sort();
  console.log('API Receipts:', apiReceipts);
  
  // Check DB
  const dbOrders = await Order.find({
    transactionType: 'SALE',
    productId: 'SPR-OB2',
    orderDate: { $gte: new Date('2025-12-01'), $lt: new Date('2026-01-01') }
  }).select('receipt').lean();
  
  console.log(`\nDB contains: ${dbOrders.length} SPR-OB2 SALE orders`);
  const dbReceipts = dbOrders.map(o => o.receipt).sort();
  console.log('DB Receipts:', dbReceipts);
  
  // Find missing
  const missing = apiReceipts.filter(r => !dbReceipts.includes(r));
  console.log(`\nMissing from DB: ${missing.length}`);
  console.log(missing);
  
  // Check those missing orders
  if (missing.length > 0) {
    console.log('\nDetails of missing orders:');
    missing.forEach(receipt => {
      const order = apiOrders.find(o => o.receipt === receipt);
      console.log(`\n${receipt}:`);
      console.log(`  Date: ${order.transactionTime}`);
      console.log(`  Product: ${order.lineItemData?.itemNo}`);
      console.log(`  Recurring: ${order.lineItemData?.recurring}`);
    });
  }
  
  await mongoose.connection.close();
}

main();