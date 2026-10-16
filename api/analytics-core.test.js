"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { amountPaise, isRevenueOrder, isPaymentAttemptOrder, revenueAmount } = require("./analytics-core");

test("a captured paid order contributes revenue using paise as the source of truth", () => {
  const order = { status: "PAID", amount: 79, amountPaise: 7901, paymentId: "pay_123" };
  assert.equal(isRevenueOrder(order), true);
  assert.equal(revenueAmount(order), 79.01);
});

test("100 percent coupon order is a completed unlock, not cash revenue", () => {
  const order = { status: "PAID", amount: 0, amountPaise: 0, paymentMethod: "COUPON", couponCode: "FREECOUPON01" };
  assert.equal(isRevenueOrder(order), false);
  assert.equal(revenueAmount(order), 0);
  assert.equal(isPaymentAttemptOrder(order), false);
});

test("legacy rupee-only paid orders are normalized to paise", () => {
  const order = { status: "PAID", amount: 49.99 };
  assert.equal(amountPaise(order), 4999);
  assert.equal(isRevenueOrder(order), true);
  assert.equal(revenueAmount(order), 49.99);
});

test("created positive-value orders count as attempts but not revenue", () => {
  const order = { status: "CREATED", amountPaise: 4900, amount: 49 };
  assert.equal(isPaymentAttemptOrder(order), true);
  assert.equal(isRevenueOrder(order), false);
});

test("superseded orders are excluded from payment success denominator", () => {
  assert.equal(isPaymentAttemptOrder({ status: "SUPERSEDED", amountPaise: 4900 }), false);
});

test("duplicate captured orders are not recognized as normal revenue", () => {
  const order = { status: "DUPLICATE_CAPTURED", amountPaise: 4900, amount: 49 };
  assert.equal(isRevenueOrder(order), false);
  assert.equal(isPaymentAttemptOrder(order), true);
});
