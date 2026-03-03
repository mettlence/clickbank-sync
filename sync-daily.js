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
    oneTime: ['abdt-basic', 'abdt-advanced', 'SSR', 'SSR-D', 'dhr', 'dhr-d']
  },
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL
  }
};

// ─── Slack Notification ────────────────────────────────────────────────────────

async function sendSlackNotification(targetDate, allStats, error = null) {
  if (!config.slack.webhookUrl) {
    console.warn('⚠ SLACK_WEBHOOK_URL not set, skipping notification.');
    return;
  }

  const success = !error;

  // Display config per transaction type
  const TYPE_LABELS = {
    'SALE':          { emoji: '🛒', label: 'Sales (New)' },
    'BILL':          { emoji: '🔄', label: 'Rebills (OB)' },
    'RFND':          { emoji: '↩️',  label: 'Refunds' },
    'CGBK':          { emoji: '🚨', label: 'Chargebacks' },
    'CANCEL-REBILL': { emoji: '❌', label: 'Cancellations' }
  };

  // Build per-type breakdown rows
  const typeRows = Object.entries(allStats).map(([type, s]) => {
    const { emoji, label } = TYPE_LABELS[type] || { emoji: '📦', label: type };
    const revenueStr = s.totalAmount > 0 ? ` · *$${s.totalAmount.toFixed(2)}*` : '';
    const failStr    = s.failed > 0 ? ` · ⚠️ Failed: *${s.failed}*` : '';
    return (
      `${emoji} *${label}*${revenueStr}\n` +
      `      Fetched: \`${s.total}\` · Inserted: \`${s.inserted}\` · Updated: \`${s.updated}\`${failStr}`
    );
  });

  // Grand totals
  const grand = Object.values(allStats).reduce((acc, s) => {
    acc.total       += s.total;
    acc.inserted    += s.inserted;
    acc.updated     += s.updated;
    acc.failed      += s.failed;
    acc.totalAmount += s.totalAmount;
    return acc;
  }, { total: 0, inserted: 0, updated: 0, failed: 0, totalAmount: 0 });

  const headerEmoji  = success ? (grand.failed > 0 ? '⚠️' : '✅') : '❌';
  const headerStatus = success
    ? (grand.failed > 0 ? 'Daily Sync Completed (with warnings)' : 'Daily Sync Completed')
    : 'Daily Sync FAILED';
  const color = success ? (grand.failed > 0 ? '#FFA500' : '#36a64f') : '#FF0000';

  const blocks = [
    // Header
    {
      type: 'header',
      text: { type: 'plain_text', text: `${headerEmoji} ClickBank ${headerStatus}`, emoji: true }
    },
    // Summary fields
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📅 Date*\n${targetDate}` },
        { type: 'mrkdwn', text: `*🏪 Vendor*\n${config.clickbank.vendor}` },
        { type: 'mrkdwn', text: `*📦 Total Fetched*\n${grand.total}` },
        { type: 'mrkdwn', text: `*💰 Revenue (new)*\n$${grand.totalAmount.toFixed(2)}` },
        { type: 'mrkdwn', text: `*✅ Inserted*\n${grand.inserted}` },
        { type: 'mrkdwn', text: `*🔁 Updated*\n${grand.updated}` }
      ]
    },
    { type: 'divider' },
    // Per-type breakdown
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Breakdown by Transaction Type*\n\n${typeRows.join('\n\n')}`
      }
    }
  ];

  // Partial failure warning
  if (success && grand.failed > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚠️ *${grand.failed} record(s) failed to process.* Check the GitHub Actions run logs for details.`
      }
    });
  }

  // Fatal error details
  if (error) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error Details*\n\`\`\`${String(error).slice(0, 2900)}\`\`\``
      }
    });
  }

  const payload = { attachments: [{ color, blocks }] };

  try {
    await axios.post(config.slack.webhookUrl, payload);
    console.log('✓ Slack notification sent');
  } catch (err) {
    console.error('✗ Failed to send Slack notification:', err.message);
  }
}

// ─── ClickBank Fetching ────────────────────────────────────────────────────────

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
    };

    try {
      console.log(`  Fetching ${type} page ${page}...`);

      const response = await axios.get(url, {
        params,
        headers: {
          'Authorization': auth,
          'Accept': 'application/json',
          'Page': page.toString()
        }
      });

      const orderData = response.data?.orderData;
      const orders = Array.isArray(orderData) ? orderData : [];

      if (orders.length > 0) {
        allOrders = allOrders.concat(orders);
        console.log(`  Page ${page}: Found ${orders.length} orders (Total: ${allOrders.length})`);
      }

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

// ─── Transform & Prepare ──────────────────────────────────────────────────────

function transformOrder(order, lineItem) {
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

  const getSiteSource = () => {
    const vendorVars = order.vendorVariables?.item;
    if (!Array.isArray(vendorVars)) return null;
    const siteSourceVar = vendorVars.find(v => v.name === 'siteSource');
    return siteSourceVar?.value || null;
  };

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
    rawData: order
  };
}

// ─── Sync Logic ───────────────────────────────────────────────────────────────

async function syncOrdersByType(startDate, endDate, type) {
  console.log(`\nFetching ${type} orders...`);

  const orders = await fetchClickBankOrders(startDate, endDate, type);
  console.log(`  Found ${orders.length} ${type} orders`);

  let processed   = 0;
  let inserted    = 0;
  let updated     = 0;
  let failed      = 0;
  let totalAmount = 0;

  for (const order of orders) {
    try {
      let lineItems = order.lineItemData;
      if (!Array.isArray(lineItems)) {
        lineItems = lineItems ? [lineItems] : [];
      }

      for (const lineItem of lineItems) {
        const transformed = transformOrder(order, lineItem);
        console.log(`  Processing ${order.receipt} (${transformed.productId}) - ${order.transactionType}`);

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
          totalAmount += transformed.amount || 0;
          console.log(`    ✓ Inserted ($${transformed.amount})`);
        } else if (result.modifiedCount > 0) {
          updated++;
          console.log(`    ✓ Updated`);
        } else {
          console.log(`    = No change`);
        }

        processed++;
      }

      // Store raw order once per receipt
      const rawOrder = prepareRawOrder(order);
      await OrderRaw.updateOne(
        { receipt: rawOrder.receipt, transactionType: rawOrder.transactionType },
        { $set: rawOrder },
        { upsert: true }
      );

    } catch (err) {
      failed++;
      console.error(`  ✗ Error processing ${order.receipt}:`, err.message);
    }
  }

  console.log(`  [${type}] ${inserted} inserted · ${updated} updated · ${failed} failed · $${totalAmount.toFixed(2)}`);

  return { type, total: orders.length, processed, inserted, updated, failed, totalAmount };
}

/**
 * Returns per-type stats: { SALE: {...}, BILL: {...}, ... }
 */
async function syncOrders(startDate, endDate) {
  console.log(`\nSyncing orders from ${startDate} to ${endDate}`);

  const types = ['SALE', 'BILL', 'RFND', 'CGBK', 'CANCEL-REBILL'];
  const allStats = {};

  for (const type of types) {
    const result = await syncOrdersByType(startDate, endDate, type);
    allStats[type] = result;
  }

  const grandTotal = Object.values(allStats).reduce((sum, s) => sum + s.processed, 0);
  console.log(`\nTotal processed: ${grandTotal} orders`);

  return allStats;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

function getTargetDate() {
  if (process.argv[2]) return process.argv[2];
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const targetDate = getTargetDate();
  let allStats = {};

  console.log('='.repeat(50));
  console.log(`DAILY SYNC — ${targetDate}`);
  console.log('='.repeat(50));

  try {
    await mongoose.connect(config.mongodb);
    console.log('✓ Connected to MongoDB');

    allStats = await syncOrders(targetDate, targetDate);

    console.log('\n✅ Daily sync completed successfully');
    await sendSlackNotification(targetDate, allStats);

    await mongoose.connection.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Fatal error:', error);

    // Always attempt Slack notification even on fatal failure
    await sendSlackNotification(targetDate, allStats, error);

    try { await mongoose.connection.close(); } catch (_) {}
    process.exit(1);
  }
}

main();