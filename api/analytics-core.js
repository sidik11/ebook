"use strict";

function amountPaise(order) {
  const raw = order?.amountPaise;
  if (raw !== undefined && raw !== null && raw !== "") {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  const rupees = Number(order?.amount || 0);
  return Number.isFinite(rupees) && rupees >= 0 ? Math.round(rupees * 100) : 0;
}

function statusOf(order) {
  return String(order?.status || order?.paymentStatus || "").trim().toUpperCase();
}

function isRevenueOrder(order) {
  return statusOf(order) === "PAID" &&
    amountPaise(order) > 0 &&
    String(order?.paymentMethod || "").trim().toUpperCase() !== "COUPON";
}

function isPaymentAttemptOrder(order) {
  const status = statusOf(order);
  return amountPaise(order) > 0 &&
    String(order?.paymentMethod || "").trim().toUpperCase() !== "COUPON" &&
    status !== "SUPERSEDED";
}

function revenueAmount(order) {
  return isRevenueOrder(order) ? amountPaise(order) / 100 : 0;
}

module.exports = { amountPaise, isRevenueOrder, isPaymentAttemptOrder, revenueAmount, statusOf };
