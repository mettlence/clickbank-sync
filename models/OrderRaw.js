const mongoose = require('mongoose');

const orderRawSchema = new mongoose.Schema({
  receipt: { type: String, required: true, index: true },
  productId: String,
  transactionType: String,
  orderDate: Date,
  rawData: { type: Object, required: true }
}, { timestamps: true });

// Make compound unique index (receipt + transactionType)
orderRawSchema.index({ receipt: 1, transactionType: 1 }, { unique: true });

module.exports = mongoose.model('OrderRaw', orderRawSchema);