// debug.js
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');

const config = {
  mongodb: process.env.MONGODB_URI
};

async function debugSalesCount() {
  try {
    await mongoose.connect(config.mongodb);
    console.log('✓ Connected to MongoDB\n');
    
    console.log('='.repeat(60));
    console.log('DEBUGGING SALES COUNT - DECEMBER 2025');
    console.log('='.repeat(60));
    
    // Method 1: Basic count
    const method1 = await Order.countDocuments({
      transactionType: 'SALE',
      orderDate: { 
        $gte: new Date('2025-12-01'), 
        $lt: new Date('2026-01-01') 
      }
    });
    
    // Method 2: With explicit timezone
    const method2 = await Order.countDocuments({
      transactionType: 'SALE',
      orderDate: { 
        $gte: new Date('2025-12-01T00:00:00Z'), 
        $lt: new Date('2026-01-01T00:00:00Z') 
      }
    });
    
    // Method 3: With isRecurring filter
    const method3 = await Order.countDocuments({
      transactionType: 'SALE',
      isRecurring: true,
      orderDate: { 
        $gte: new Date('2025-12-01'), 
        $lt: new Date('2026-01-01') 
      }
    });
    
    // Method 4: With status filter (analytics query)
    const method4 = await Order.countDocuments({
      transactionType: 'SALE',
      isRecurring: true,
      subscriptionStatus: { $in: ['ACTIVE', 'CANCELED'] },
      orderDate: { 
        $gte: new Date('2025-12-01'), 
        $lt: new Date('2026-01-01') 
      }
    });
    
    console.log('\nCOUNT COMPARISON:');
    console.log(`Method 1 (basic):              ${method1}`);
    console.log(`Method 2 (explicit timezone):  ${method2}`);
    console.log(`Method 3 (+ isRecurring):      ${method3}`);
    console.log(`Method 4 (analytics query):    ${method4}`);
    console.log(`\nExpected: 62 (11 SPR-OB1 + 51 SPR-OB2)`);
    console.log(`Discrepancy: ${62 - method4}`);
    
    // Check date range in DB
    console.log('\n' + '='.repeat(60));
    console.log('DATE RANGE IN DATABASE');
    console.log('='.repeat(60));
    
    const minMax = await Order.aggregate([
      { $match: { transactionType: 'SALE' } },
      { $group: { 
        _id: null, 
        minDate: { $min: '$orderDate' },
        maxDate: { $max: '$orderDate' },
        count: { $sum: 1 }
      }}
    ]);
    
    console.log('Overall SALE records:', minMax[0]);
    
    // List all SALE records for Dec 2025
    console.log('\n' + '='.repeat(60));
    console.log('ALL DECEMBER 2025 SALE RECORDS');
    console.log('='.repeat(60));
    
    const sales = await Order.find({
      transactionType: 'SALE',
      orderDate: { 
        $gte: new Date('2025-12-01'), 
        $lt: new Date('2026-01-01') 
      }
    }).select('receipt orderDate productId isRecurring subscriptionStatus').sort({ orderDate: 1 }).lean();
    
    console.log(`\nFound ${sales.length} SALE records in December 2025:`);
    console.log('');
    
    sales.forEach((sale, idx) => {
      console.log(`${idx + 1}. Receipt: ${sale.receipt.padEnd(15)} | Date: ${sale.orderDate.toISOString()} | Product: ${sale.productId} | Recurring: ${sale.isRecurring} | Status: ${sale.subscriptionStatus}`);
    });
    
    // Check for missing isRecurring or status
    console.log('\n' + '='.repeat(60));
    console.log('FILTERING ANALYSIS');
    console.log('='.repeat(60));
    
    const notRecurring = sales.filter(s => !s.isRecurring);
    const noStatus = sales.filter(s => !s.subscriptionStatus);
    const excludedByStatus = sales.filter(s => !['ACTIVE', 'CANCELED'].includes(s.subscriptionStatus));
    
    console.log(`\nRecords with isRecurring=false: ${notRecurring.length}`);
    if (notRecurring.length > 0) {
      notRecurring.forEach(s => console.log(`  - ${s.receipt} (${s.productId})`));
    }
    
    console.log(`\nRecords with no status: ${noStatus.length}`);
    if (noStatus.length > 0) {
      noStatus.forEach(s => console.log(`  - ${s.receipt} (${s.productId})`));
    }
    
    console.log(`\nRecords excluded by status filter: ${excludedByStatus.length}`);
    if (excludedByStatus.length > 0) {
      excludedByStatus.forEach(s => console.log(`  - ${s.receipt} (${s.productId}) - Status: ${s.subscriptionStatus}`));
    }
    
    // Count by product
    console.log('\n' + '='.repeat(60));
    console.log('COUNT BY PRODUCT');
    console.log('='.repeat(60));
    
    const byProduct = await Order.aggregate([
      {
        $match: {
          transactionType: 'SALE',
          orderDate: { 
            $gte: new Date('2025-12-01'), 
            $lt: new Date('2026-01-01') 
          }
        }
      },
      {
        $group: {
          _id: '$productId',
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    byProduct.forEach(p => {
      console.log(`${p._id}: ${p.count}`);
    });
    
    console.log('\n' + '='.repeat(60));
    console.log('DEBUG COMPLETE');
    console.log('='.repeat(60) + '\n');
    
    await mongoose.connection.close();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

debugSalesCount();