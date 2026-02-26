// check-missing.js
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const missing = ['4LD4M9XE', '67G5MLGE', 'GF6WMCPE', 'GF6WMVCE', 'TMNWMDVE'];
  
  console.log('Checking missing receipts in DB:\n');
  
  for (const receipt of missing) {
    const orders = await Order.find({ receipt: { $regex: receipt } }).lean();
    
    console.log(`${receipt}:`);
    if (orders.length === 0) {
      console.log('  NOT FOUND IN DB AT ALL ❌');
    } else {
      orders.forEach(o => {
        console.log(`  Found: ${o.receipt} - Type: ${o.transactionType} - Status: ${o.subscriptionStatus} - Date: ${o.orderDate}`);
      });
    }
    console.log('');
  }
  
  await mongoose.connection.close();
}

main();