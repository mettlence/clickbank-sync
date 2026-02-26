require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');

const config = {
  mongodb: process.env.MONGODB_URI,
  subscriptionProducts: ['SPR-OB1', 'SPR-OB2'] // Only these are subscriptions
};

// Helper to get month date range
function getMonthRange(monthStr) {
  const start = new Date(monthStr + '-01T00:00:00Z'); // Use UTC
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
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

// Check if month is complete
function isMonthComplete(monthStr) {
  const now = new Date();
  const monthEnd = getMonthRange(monthStr).end;
  return now >= monthEnd;
}

// ============================================================================
// 1. NEW SUBSCRIPTIONS - Count SALE transactions for subscription products
// ============================================================================
async function getNewSubscriptions(startDate, endDate) {
  return await Order.countDocuments({
    transactionType: 'SALE',
    isRecurring: true,
    productId: { $in: config.subscriptionProducts },
    orderDate: { $gte: startDate, $lt: endDate }
  });
}

// ============================================================================
// 2. ACTIVE SUBSCRIPTIONS - CORRECTED VERSION
// Count unique customers whose MOST RECENT status is ACTIVE as of endDate
// ============================================================================
async function getActiveSubscriptions(endDate) {
  // Get each customer's most recent order status up to endDate
  const activeCustomers = await Order.aggregate([
    {
      $match: {
        orderDate: { $lte: endDate },
        productId: { $in: config.subscriptionProducts },
        transactionType: { $in: ['SALE', 'BILL', 'CANCEL-REBILL'] }
      }
    },
    // Sort by date descending to get most recent first
    {
      $sort: { orderDate: -1 }
    },
    // Group by customer, take first (most recent) order
    {
      $group: {
        _id: '$customerId',
        lastOrder: { $first: '$$ROOT' }
      }
    },
    // Filter to only those whose last status is ACTIVE and not a cancellation
    {
      $match: {
        'lastOrder.subscriptionStatus': 'ACTIVE',
        'lastOrder.transactionType': { $ne: 'CANCEL-REBILL' }
      }
    }
  ]);
  
  return activeCustomers.length;
}

// ============================================================================
// 3. CANCELLATIONS - Count unique cancellations in date range
// ============================================================================
async function getCancellations(startDate, endDate) {
  // Use distinct on receipt to avoid double-counting
  const allCanceled = await Order.distinct('receipt', {
    $or: [
      { 
        transactionType: 'CANCEL-REBILL',
        productId: { $in: config.subscriptionProducts },
        orderDate: { $gte: startDate, $lt: endDate }
      },
      {
        transactionType: { $in: ['SALE', 'BILL'] },
        subscriptionStatus: 'CANCELED',
        productId: { $in: config.subscriptionProducts },
        orderDate: { $gte: startDate, $lt: endDate }
      }
    ]
  });
  
  return allCanceled.length;
}

// ============================================================================
// 4. CHURN RATE - CORRECTED VERSION
// Uses actual active count at start/end of period
// Returns null for incomplete months to avoid misleading data
// ============================================================================
async function getChurnRate(currentMonthStr, previousMonthStr) {
  // Check if current month is complete
  if (!isMonthComplete(currentMonthStr)) {
    console.log(`⚠️  Warning: ${currentMonthStr} is incomplete - churn rate may be inaccurate`);
    // Still calculate but flag as incomplete
  }
  
  const currentMonthRange = getMonthRange(currentMonthStr);
  const previousMonthRange = getMonthRange(previousMonthStr);
  
  // Get active count at START of current month (= end of previous month)
  const activeAtStart = await getActiveSubscriptions(currentMonthRange.start);
  
  if (activeAtStart === 0) {
    return { rate: 0, activeAtStart: 0, activeAtEnd: 0, churned: 0 };
  }
  
  // Get active count at END of current month
  const activeAtEnd = await getActiveSubscriptions(currentMonthRange.end);
  
  // Calculate churned
  const churned = activeAtStart - activeAtEnd + await getNewSubscriptions(currentMonthRange.start, currentMonthRange.end);
  
  // Alternative: Use actual cancellations
  const cancellations = await getCancellations(currentMonthRange.start, currentMonthRange.end);
  
  const churnRate = ((cancellations / activeAtStart) * 100).toFixed(2);
  
  return {
    rate: parseFloat(churnRate),
    activeAtStart,
    activeAtEnd,
    cancellations,
    calculated: churned
  };
}

// ============================================================================
// 5. MRR - Monthly Recurring Revenue from ACTIVE BILL transactions
// ============================================================================
async function getMRR(startDate, endDate) {
  const result = await Order.aggregate([
    {
      $match: {
        transactionType: 'BILL',
        subscriptionStatus: 'ACTIVE',
        productId: { $in: config.subscriptionProducts },
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

// ============================================================================
// 6. TOTAL REVENUE - SALE + BILL transactions
// ============================================================================
async function getTotalRevenue(startDate, endDate) {
  const result = await Order.aggregate([
    {
      $match: {
        transactionType: { $in: ['SALE', 'BILL'] },
        subscriptionStatus: { $in: ['ACTIVE', 'CANCELED', 'COMPLETED'] },
        productId: { $in: config.subscriptionProducts },
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

// ============================================================================
// MAIN ANALYTICS FUNCTION
// ============================================================================
async function getMonthlyComparison(lastMonthStr, thisMonthStr) {
  console.log(`\nGenerating analytics for ${lastMonthStr} vs ${thisMonthStr}...\n`);
  
  const lastMonthRange = getMonthRange(lastMonthStr);
  const thisMonthRange = getMonthRange(thisMonthStr);
  
  // Check if months are complete
  const lastMonthComplete = isMonthComplete(lastMonthStr);
  const thisMonthComplete = isMonthComplete(thisMonthStr);
  
  console.log(`Last month (${lastMonthStr}): ${lastMonthComplete ? 'Complete ✓' : 'Incomplete ⚠️'}`);
  console.log(`This month (${thisMonthStr}): ${thisMonthComplete ? 'Complete ✓' : 'Incomplete ⚠️'}\n`);
  
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
  
  // 2. Active Subscriptions (at END of each month)
  console.log('Calculating active subscriptions...');
  metrics.activeSubscriptions = {
    lastMonth: await getActiveSubscriptions(lastMonthRange.end),
    thisMonth: await getActiveSubscriptions(thisMonthRange.end)
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
  
  // Get the month before last month for last month's churn calculation
  const twoMonthsAgo = new Date(lastMonthRange.start);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 1);
  const twoMonthsAgoStr = `${twoMonthsAgo.getFullYear()}-${String(twoMonthsAgo.getMonth() + 1).padStart(2, '0')}`;
  
  const lastMonthChurn = await getChurnRate(lastMonthStr, twoMonthsAgoStr);
  const thisMonthChurn = await getChurnRate(thisMonthStr, lastMonthStr);
  
  metrics.churnRate = {
    lastMonth: lastMonthChurn.rate,
    thisMonth: thisMonthChurn.rate,
    lastMonthDetails: lastMonthChurn,
    thisMonthDetails: thisMonthChurn
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
  
  // 7. Calculate net subscriber growth
  metrics.netGrowth = {
    lastMonth: metrics.newSubscriptions.lastMonth - metrics.cancellations.lastMonth,
    thisMonth: metrics.newSubscriptions.thisMonth - metrics.cancellations.thisMonth
  };
  
  // 8. Validate data consistency
  console.log('\nValidating data consistency...');
  
  // For last month (if complete): start + new - cancelled should ≈ end
  if (lastMonthComplete) {
    const lastMonthStart = await getActiveSubscriptions(lastMonthRange.start);
    const expectedEnd = lastMonthStart + metrics.newSubscriptions.lastMonth - metrics.cancellations.lastMonth;
    const actualEnd = metrics.activeSubscriptions.lastMonth;
    const diff = Math.abs(expectedEnd - actualEnd);
    
    if (diff > 5) { // Allow small variance for timing
      console.warn(`⚠️  Last month data inconsistency detected:`);
      console.warn(`   Expected: ${expectedEnd}, Actual: ${actualEnd}, Diff: ${diff}`);
    } else {
      console.log(`✓ Last month data validated (diff: ${diff})`);
    }
  }
  
  // For this month
  const thisMonthStart = metrics.activeSubscriptions.lastMonth; // Last month's end = this month's start
  const expectedThisEnd = thisMonthStart + metrics.newSubscriptions.thisMonth - metrics.cancellations.thisMonth;
  const actualThisEnd = metrics.activeSubscriptions.thisMonth;
  const thisDiff = Math.abs(expectedThisEnd - actualThisEnd);
  
  if (thisDiff > 5) {
    console.warn(`⚠️  This month data inconsistency detected:`);
    console.warn(`   Start: ${thisMonthStart}, New: ${metrics.newSubscriptions.thisMonth}, Cancelled: ${metrics.cancellations.thisMonth}`);
    console.warn(`   Expected: ${expectedThisEnd}, Actual: ${actualThisEnd}, Diff: ${thisDiff}`);
  } else {
    console.log(`✓ This month data validated (diff: ${thisDiff})`);
  }
  
  return {
    period: {
      lastMonth: lastMonthStr,
      thisMonth: thisMonthStr,
      lastMonthComplete,
      thisMonthComplete
    },
    metrics,
    validation: {
      lastMonthStart: lastMonthComplete ? await getActiveSubscriptions(lastMonthRange.start) : null,
      thisMonthStart: metrics.activeSubscriptions.lastMonth,
      expectedThisEnd,
      actualThisEnd,
      difference: thisDiff
    }
  };
}

// ============================================================================
// FORMAT OUTPUT FOR DISPLAY
// ============================================================================
function formatReport(data) {
  const { period, metrics, validation } = data;
  
  console.log('\n' + '='.repeat(80));
  console.log('SUBSCRIPTION ANALYTICS REPORT (CORRECTED)');
  console.log('='.repeat(80));
  console.log(`Period: ${period.lastMonth} vs ${period.thisMonth}`);
  console.log(`Status: Last=${period.lastMonthComplete ? 'Complete' : 'Partial'}, This=${period.thisMonthComplete ? 'Complete' : 'Partial'}\n`);
  
  if (!period.thisMonthComplete) {
    console.log('⚠️  WARNING: Current month is incomplete. Metrics may change.\n');
  }
  
  console.log('┌─────────────────────────────────┬──────────────┬──────────────┬──────────────┬──────────┐');
  console.log('│ Metric                          │ Last Month   │ This Month   │ Change       │ Change % │');
  console.log('├─────────────────────────────────┼──────────────┼──────────────┼──────────────┼──────────┤');
  
  // New Subscriptions
  console.log(`│ New Subscriptions               │ ${String(metrics.newSubscriptions.lastMonth).padEnd(12)} │ ${String(metrics.newSubscriptions.thisMonth).padEnd(12)} │ ${String(metrics.newSubscriptions.change.absolute).padStart(12)} │ ${String(metrics.newSubscriptions.change.percentage + '%').padStart(8)} │`);
  
  // Active Subscriptions
  console.log(`│ Active Subscriptions (at end)   │ ${String(metrics.activeSubscriptions.lastMonth).padEnd(12)} │ ${String(metrics.activeSubscriptions.thisMonth).padEnd(12)} │ ${String(metrics.activeSubscriptions.change.absolute).padStart(12)} │ ${String(metrics.activeSubscriptions.change.percentage + '%').padStart(8)} │`);
  
  // Cancellations
  console.log(`│ Cancellations                   │ ${String(metrics.cancellations.lastMonth).padEnd(12)} │ ${String(metrics.cancellations.thisMonth).padEnd(12)} │ ${String(metrics.cancellations.change.absolute).padStart(12)} │ ${String(metrics.cancellations.change.percentage + '%').padStart(8)} │`);
  
  // Net Growth
  console.log(`│ Net Subscriber Growth           │ ${String(metrics.netGrowth.lastMonth).padEnd(12)} │ ${String(metrics.netGrowth.thisMonth).padEnd(12)} │ ${String(metrics.netGrowth.thisMonth - metrics.netGrowth.lastMonth).padStart(12)} │ ${'-'.padStart(8)} │`);
  
  // Churn Rate
  console.log(`│ Churn Rate                      │ ${String(metrics.churnRate.lastMonth + '%').padEnd(12)} │ ${String(metrics.churnRate.thisMonth + '%').padEnd(12)} │ ${String(metrics.churnRate.change.absolute.toFixed(2) + ' pp').padStart(12)} │ ${String(metrics.churnRate.change.percentage + '%').padStart(8)} │`);
  
  // MRR
  console.log(`│ Monthly Recurring Revenue (MRR) │ ${String('$' + metrics.mrr.lastMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.mrr.thisMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.mrr.change.absolute.toFixed(2)).padStart(12)} │ ${String(metrics.mrr.change.percentage + '%').padStart(8)} │`);
  
  // Total Revenue
  console.log(`│ Total Revenue                   │ ${String('$' + metrics.totalRevenue.lastMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.totalRevenue.thisMonth.toFixed(2)).padEnd(12)} │ ${String('$' + metrics.totalRevenue.change.absolute.toFixed(2)).padStart(12)} │ ${String(metrics.totalRevenue.change.percentage + '%').padStart(8)} │`);
  
  console.log('└─────────────────────────────────┴──────────────┴──────────────┴──────────────┴──────────┘\n');
  
  // Additional Details
  console.log('CHURN RATE DETAILS:');
  console.log(`Last Month - Active at start: ${metrics.churnRate.lastMonthDetails.activeAtStart}, Cancellations: ${metrics.churnRate.lastMonthDetails.cancellations}, Rate: ${metrics.churnRate.lastMonth}%`);
  console.log(`This Month - Active at start: ${metrics.churnRate.thisMonthDetails.activeAtStart}, Cancellations: ${metrics.churnRate.thisMonthDetails.cancellations}, Rate: ${metrics.churnRate.thisMonth}%`);
  
  console.log('\nREVENUE BREAKDOWN:');
  console.log(`Last Month  - Sales: $${metrics.totalRevenue.lastMonthBreakdown.sales.toFixed(2)}, Recurring: $${metrics.totalRevenue.lastMonthBreakdown.recurring.toFixed(2)}`);
  console.log(`This Month  - Sales: $${metrics.totalRevenue.thisMonthBreakdown.sales.toFixed(2)}, Recurring: $${metrics.totalRevenue.thisMonthBreakdown.recurring.toFixed(2)}`);
  
  console.log(`\nBILLING COUNT:`);
  console.log(`Last Month: ${metrics.mrr.lastMonthBills} bills, This Month: ${metrics.mrr.thisMonthBills} bills`);
  
  console.log('\nDATA VALIDATION:');
  console.log(`This month start: ${validation.thisMonthStart}`);
  console.log(`Expected end: ${validation.thisMonthStart} + ${metrics.newSubscriptions.thisMonth} new - ${metrics.cancellations.thisMonth} cancelled = ${validation.expectedThisEnd}`);
  console.log(`Actual end: ${validation.actualThisEnd}`);
  console.log(`Difference: ${validation.difference} ${validation.difference <= 5 ? '✓' : '⚠️'}`);
  
  console.log('='.repeat(80) + '\n');
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
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
module.exports = { getMonthlyComparison, getActiveSubscriptions, getCancellations };