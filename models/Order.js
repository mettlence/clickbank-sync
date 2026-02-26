const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  receipt: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  customerId: String,
  customerEmail: String,
  transactionType: { type: String, required: true, index: true },
  amount: Number,
  currency: String,
  orderDate: { type: Date, index: true },
  subscriptionStatus: String,
  isRecurring: Boolean,
  processedPayments: Number,
  nextPaymentDate: Date,
  rebillAmount: { type: Number, default: null },
  siteSource: { type: String, index: true },
  lineItemType: String
}, { timestamps: true });

orderSchema.index({ receipt: 1, transactionType: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('Order', orderSchema);