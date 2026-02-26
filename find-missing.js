// find-missing-2.js
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

async function fetchOrders(startDate, endDate, type, productId) {
  const auth = `${config.clickbank.clerkKey}:${config.clickbank.devKey}`;
  const response = await axios.get(`${config.clickbank.baseURL}/orders2/list`, {
    params: { startDate, endDate, item: productId, type, role: 'VENDOR' },
    headers: { 'Authorization': auth, 'Accept': 'application/json' }
  });
  return response.data?.orderData || [];
}

async function main() {
  await mongoose.connect(config.mongodb);
  
  // Fetch both products from API
  const ob1Api = await fetchOrders('2025-12-01', '2025-12-31', 'SALE', 'SPR-OB1');
  const ob2Api = await fetchOrders('2025-12-01', '2025-12-31', 'SALE', 'SPR-OB2');
  
  console.log(`API: SPR-OB1 = ${ob1Api.length}, SPR-OB2 = ${ob2Api.length}, Total = ${ob1Api.length + ob2Api.length}`);
  
  const allApiReceipts = [...ob1Api, ...ob2Api].map(o => o.receipt).sort();
  
  // Check DB with analytics query logic
  const dbCount = await Order.countDocuments({
    transactionType: 'SALE',
    isRecurring: true,
    subscriptionStatus: { $in: ['ACTIVE', 'CANCELED', 'VALIDATION_FAILURE'] },
    orderDate: { 
      $gte: new Date('2025-12-01'),
      $lt: new Date('2026-01-01')
    }
  });
  
  const dbOrders = await Order.find({
    transactionType: 'SALE',
    isRecurring: true,
    subscriptionStatus: { $in: ['ACTIVE', 'CANCELED', 'VALIDATION_FAILURE'] },
    orderDate: { 
      $gte: new Date('2025-12-01'),
      $lt: new Date('2026-01-01')
    }
  }).select('receipt productId orderDate').lean();
  
  console.log(`DB: Total = ${dbCount}`);
  
  const dbReceipts = dbOrders.map(o => o.receipt).sort();
  
  // Find missing
  const missing = allApiReceipts.filter(r => !dbReceipts.includes(r));
  
  console.log(`\nMissing: ${missing.length}`);
  console.log(missing);
  
  if (missing.length > 0) {
    console.log('\nDetails:');
    missing.forEach(receipt => {
      const order = [...ob1Api, ...ob2Api].find(o => o.receipt === receipt);
      console.log(`\n${receipt}:`);
      console.log(`  API Date: ${order.transactionTime}`);
      console.log(`  Product: ${order.lineItemData?.itemNo}`);
      console.log(`  Status: ${order.lineItemData?.status}`);
      console.log(`  Recurring: ${order.lineItemData?.recurring}`);
    });
    
    // Check if they exist in DB with different filters
    console.log('\n--- Checking if exists in DB without filters ---');
    for (const receipt of missing) {
      const found = await Order.findOne({ receipt }).lean();
      if (found) {
        console.log(`${receipt}: EXISTS - Type: ${found.transactionType}, Status: ${found.subscriptionStatus}, Recurring: ${found.isRecurring}, Date: ${found.orderDate}`);
      } else {
        console.log(`${receipt}: NOT IN DB AT ALL`);
      }
    }
  }

  const duplicates = await Order.aggregate([
    {
      $match: {
        transactionType: 'BILL',
        orderDate: { $gte: new Date('2026-01-01'), $lt: new Date('2026-02-01') }
      }
    },
    {
      $group: {
        _id: '$customerId',
        count: { $sum: 1 }
      }
    },
    {
      $match: { count: { $gt: 1 } }
    }
  ]);

  console.log('Customers with multiple bills:', duplicates);
  
  await mongoose.connection.close();
}

main();