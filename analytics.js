// ============================================================================
// FILE: analytics.js
// PURPOSE: Phase 1 Analytics - Monthly subscription metrics comparison
// ============================================================================

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');

const config = {
  mongodb: process.env.MONGODB_URI
};

// Helper to get month date range
function getMonthRange(monthStr) {
  const start = new Date(monthStr + '-01T00:00:00-08:00');
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

// Helper to format currency
function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency
  }).format(amount);
}

// Helper to calculate percentage change
function calculateChange(lastMonth, thisMonth) {
  const change = thisMonth - lastMonth;
  const changePercent = lastMonth > 0 
    ? ((change / lastMonth) * 100).toFixed(2)
    : (thisMonth > 0 ? 100 : 0);
  
  return {
    absolute: change,
    percentage: parseFloat(changePercent),
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
  };
}

// 1. New Subscriptions - Only count ACTIVE status
async function getNewSubscriptions(startDate, endDate) {
  return await Order.countDocuments({
    transactionType: 'SALE',
    isRecurring: true,
    // subscriptionStatus: { $in: ['ACTIVE', 'CANCELED', 'VALIDATION_FAILURE'] }, // Include all to track acquisition
    orderDate: { $gte: startDate, $lt: endDate }
  });
}

// 2. Active Subscriptions - Only ACTIVE status with BILL
async function getActiveSubscriptions(startDate, endDate) {
  const activeCustomers = await Order.distinct('customerId', {
    transactionType: 'BILL',
    subscriptionStatus: 'ACTIVE', // CRITICAL: Only count ACTIVE
    orderDate: { $gte: startDate, $lt: endDate }
  });
  
  return activeCustomers.length;
}

// 3. Cancellations - Check both CANCEL-REBILL and status changes
async function getCancellations(startDate, endDate) {
  // Method 1: Explicit cancellation transactions
  const cancelRebills = await Order.countDocuments({
    transactionType: 'CANCEL-REBILL',
    orderDate: { $gte: startDate, $lt: endDate }
  });
  
  // Method 2: SALE/BILL with CANCELED status (caught later)
  const canceledSales = await Order.countDocuments({
    transactionType: { $in: ['SALE', 'BILL'] },
    subscriptionStatus: 'CANCELED',
    orderDate: { $gte: startDate, $lt: endDate }
  });
  
  // Use the higher count (avoid duplicates by using distinct receipts)
  const allCanceled = await Order.distinct('receipt', {
    $or: [
      { 
        transactionType: 'CANCEL-REBILL',
        orderDate: { $gte: startDate, $lt: endDate }
      },
      {
        transactionType: { $in: ['SALE', 'BILL'] },
        subscriptionStatus: 'CANCELED',
        orderDate: { $gte: startDate, $lt: endDate }
      }
    ]
  });
  
  return allCanceled.length;
}

// 4. Churn Rate - Cancelled / Active at start of period
async function getChurnRate(currentMonthStart, currentMonthEnd, previousMonthStart, previousMonthEnd) {
  // Active subscribers at START of current month (= active in previous month)
  const activeAtStart = await Order.distinct('customerId', {
    transactionType: 'BILL',
    // subscriptionStatus: 'ACTIVE',
    orderDate: { $gte: previousMonthStart, $lt: previousMonthEnd }
  });
  
  if (activeAtStart.length === 0) return 0;
  
  // Active subscribers at END of current month
  const activeAtEnd = await Order.distinct('customerId', {
    transactionType: 'BILL',
    // subscriptionStatus: 'ACTIVE',
    orderDate: { $gte: currentMonthStart, $lt: currentMonthEnd }
  });
  
  // Churned = was active at start BUT NOT active at end
  const churned = activeAtStart.filter(id => !activeAtEnd.includes(id));
  
  return ((churned.length / activeAtStart.length) * 100).toFixed(2);
}

// 5. Monthly Recurring Revenue - Only from ACTIVE BILL transactions
async function getMRR(startDate, endDate) {
  const result = await Order.aggregate([
    {
      $match: {
        transactionType: 'BILL',
        subscriptionStatus: 'ACTIVE', // CRITICAL: Only count ACTIVE
        orderDate: { $gte: startDate, $lt: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalMRR: { $sum: '$rebillAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  return result[0] || { totalMRR: 0, count: 0 };
}

// 6. Total Revenue - SALE + BILL (only ACTIVE status)
async function getTotalRevenue(startDate, endDate) {
  const result = await Order.aggregate([
    {
      $match: {
        transactionType: { $in: ['SALE', 'BILL'] },
        subscriptionStatus: { $in: ['ACTIVE', 'CANCELED'] }, // Count initial sales even if later canceled
        orderDate: { $gte: startDate, $lt: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$amount' },
        salesRevenue: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'SALE'] }, '$amount', 0]
          }
        },
        recurringRevenue: {
          $sum: {
            $cond: [{ $eq: ['$transactionType', 'BILL'] }, '$amount', 0]
          }
        }
      }
    }
  ]);
  
  return result[0] || { totalRevenue: 0, salesRevenue: 0, recurringRevenue: 0 };
}

// Main analytics function
async function getMonthlyComparison(lastMonthStr, thisMonthStr) {
  console.log(`\nGenerating analytics for ${lastMonthStr} vs ${thisMonthStr}...\n`);
  
  const lastMonthRange = getMonthRange(lastMonthStr);
  const thisMonthRange = getMonthRange(thisMonthStr);
  
  // For churn calculation, we need the month before last month
  const twoMonthsAgo = new Date(lastMonthRange.start);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 1);
  const twoMonthsAgoEnd = new Date(lastMonthRange.start);
  
  // Collect all metrics
  const metrics = {};
  
  // 1. New Subscriptions
  console.log('Calculating new subscriptions...');
  metrics.newSubscriptions = {
    lastMonth: await getNewSubscriptions(lastMonthRange.start, lastMonthRange.end),
    thisMonth: await getNewSubscriptions(thisMonthRange.start, thisMonthRange.end)
  };
  metrics.newSubscriptions.change = calculateChange(
    metrics.newSubscriptions.lastMonth,
    metrics.newSubscriptions.thisMonth
  );
  
  // 2. Active Subscriptions
  console.log('Calculating active subscriptions...');
  metrics.activeSubscriptions = {
    lastMonth: await getActiveSubscriptions(lastMonthRange.start, lastMonthRange.end),
    thisMonth: await getActiveSubscriptions(thisMonthRange.start, thisMonthRange.end)
  };
  metrics.activeSubscriptions.change = calculateChange(
    metrics.activeSubscriptions.lastMonth,
    metrics.activeSubscriptions.thisMonth
  );
  
  // 3. Cancellations
  console.log('Calculating cancellations...');
  metrics.cancellations = {
    lastMonth: await getCancellations(lastMonthRange.start, lastMonthRange.end),
    thisMonth: await getCancellations(thisMonthRange.start, thisMonthRange.end)
  };
  metrics.cancellations.change = calculateChange(
    metrics.cancellations.lastMonth,
    metrics.cancellations.thisMonth
  );
  
  // 4. Churn Rate
  console.log('Calculating churn rate...');
  metrics.churnRate = {
    lastMonth: parseFloat(await getChurnRate(
      lastMonthRange.start,
      lastMonthRange.end,
      twoMonthsAgo,
      twoMonthsAgoEnd
    )),
    thisMonth: parseFloat(await getChurnRate(
      thisMonthRange.start,
      thisMonthRange.end,
      lastMonthRange.start,
      lastMonthRange.end
    ))
  };
  metrics.churnRate.change = calculateChange(
    metrics.churnRate.lastMonth,
    metrics.churnRate.thisMonth
  );
  
  // 5. MRR
  console.log('Calculating MRR...');
  const lastMonthMRR = await getMRR(lastMonthRange.start, lastMonthRange.end);
  const thisMonthMRR = await getMRR(thisMonthRange.start, thisMonthRange.end);
  
  metrics.mrr = {
    lastMonth: lastMonthMRR.totalMRR,
    thisMonth: thisMonthMRR.totalMRR,
    lastMonthBills: lastMonthMRR.count,
    thisMonthBills: thisMonthMRR.count
  };
  metrics.mrr.change = calculateChange(
    metrics.mrr.lastMonth,
    metrics.mrr.thisMonth
  );
  
  // 6. Total Revenue
  console.log('Calculating total revenue...');
  const lastMonthRevenue = await getTotalRevenue(lastMonthRange.start, lastMonthRange.end);
  const thisMonthRevenue = await getTotalRevenue(thisMonthRange.start, thisMonthRange.end);
  
  metrics.totalRevenue = {
    lastMonth: lastMonthRevenue.totalRevenue,
    thisMonth: thisMonthRevenue.totalRevenue,
    lastMonthBreakdown: {
      sales: lastMonthRevenue.salesRevenue,
      recurring: lastMonthRevenue.recurringRevenue
    },
    thisMonthBreakdown: {
      sales: thisMonthRevenue.salesRevenue,
      recurring: thisMonthRevenue.recurringRevenue
    }
  };
  metrics.totalRevenue.change = calculateChange(
    metrics.totalRevenue.lastMonth,
    metrics.totalRevenue.thisMonth
  );
  
  return {
    period: {
      lastMonth: lastMonthStr,
      thisMonth: thisMonthStr
    },
    metrics
  };
}

// Format output for display
function formatReport(data) {
  const { period, metrics } = data;
  
  console.log('\n' + '='.repeat(80));
  console.log('SUBSCRIPTION ANALYTICS REPORT');
  console.log('='.repeat(80));
  console.log(`Period: ${period.lastMonth} vs ${period.thisMonth}\n`);
  
  console.log('┌─────────────────────────────────┬──────────────┬──────────────┬──────────────┬──────────┐');
  console.log('│ Metric                          │ Last Month   │ This Month   │ Change       │ Change % │');
  console.log('├─────────────────────────────────┼──────────────┼──────────────┼──────────────┼──────────┤');
  
  // New Subscriptions
  console.log(`│ New Subscriptions               │ ${String(metrics.newSubscriptions.lastMonth).padEnd(12)} │ ${String(metrics.newSubscriptions.thisMonth).padEnd(12)} │ ${String(metrics.newSubscriptions.change.absolute).padStart(12)} │ ${String(metrics.newSubscriptions.change.percentage + '%').padStart(8)} │`);
  
  // Active Subscriptions
  console.log(`│ Active Subscriptions            │ ${String(metrics.activeSubscriptions.lastMonth).padEnd(12)} │ ${String(metrics.activeSubscriptions.thisMonth).padEnd(12)} │ ${String(metrics.activeSubscriptions.change.absolute).padStart(12)} │ ${String(metrics.activeSubscriptions.change.percentage + '%').padStart(8)} │`);
  
  // Cancellations
  console.log(`│ Cancellations                   │ ${String(metrics.cancellations.lastMonth).padEnd(12)} │ ${String(metrics.cancellations.thisMonth).padEnd(12)} │ ${String(metrics.cancellations.change.absolute).padStart(12)} │ ${String(metrics.cancellations.change.percentage + '%').padStart(8)} │`);
  
  // Churn Rate
  console.log(`│ Churn Rate                      │ ${String(metrics.churnRate.lastMonth + '%').padEnd(12)} │ ${String(metrics.churnRate.thisMonth + '%').padEnd(12)} │ ${String(metrics.churnRate.change.absolute.toFixed(2) + '%').padStart(12)} │ ${String(metrics.churnRate.change.percentage + '%').padStart(8)} │`);
  
  // MRR
  console.log(`│ Monthly Recurring Revenue (MRR) │ ${String('$' + metrics.mrr.lastMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.mrr.thisMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.mrr.change.absolute.toFixed(2)).padStart(12)} │ ${String(metrics.mrr.change.percentage + '%').padStart(8)} │`);
  
  // Total Revenue
  console.log(`│ Total Revenue                   │ ${String('$' + metrics.totalRevenue.lastMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.totalRevenue.thisMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.totalRevenue.change.absolute.toFixed(2)).padStart(12)} │ ${String(metrics.totalRevenue.change.percentage + '%').padStart(8)} │`);
  
  console.log('└─────────────────────────────────┴──────────────┴──────────────┴──────────────┴──────────┘\n');
  
  // Additional Details
  console.log('REVENUE BREAKDOWN:');
  console.log(`Last Month  - Sales: $${metrics.totalRevenue.lastMonthBreakdown.sales.toFixed(2)}, Recurring: $${metrics.totalRevenue.lastMonthBreakdown.recurring.toFixed(2)}`);
  console.log(`This Month  - Sales: $${metrics.totalRevenue.thisMonthBreakdown.sales.toFixed(2)}, Recurring: $${metrics.totalRevenue.thisMonthBreakdown.recurring.toFixed(2)}`);
  console.log(`\nBilling Count - Last Month: ${metrics.mrr.lastMonthBills}, This Month: ${metrics.mrr.thisMonthBills}`);
  console.log('='.repeat(80) + '\n');
}

// Main execution
async function main() {
  try {
    await mongoose.connect(config.mongodb);
    console.log('✓ Connected to MongoDB');
    
    const now = new Date();
    
    // Default: Compare last month vs this month
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(now);
    lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
    
    // Allow custom months via command line args
    const customLastMonth = process.argv[2] || lastMonth;
    const customThisMonth = process.argv[3] || thisMonth;
    
    const report = await getMonthlyComparison(customLastMonth, customThisMonth);
    
    formatReport(report);
    
    // Also return JSON for API use
    console.log('JSON Output:');
    console.log(JSON.stringify(report, null, 2));
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// Export for API use
module.exports = { getMonthlyComparison };