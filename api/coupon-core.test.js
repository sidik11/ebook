"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { claimFreeCouponRedemption, couponPercent, discountPaise, timestampMs } = require("./coupon-core");

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const base = () => ({ code: "FREECOUPON01", discountPercent: 100, maxUses: 2, usedCount: 0, status: "ACTIVE", reservations: {}, redemptions: {} });
const claim = (current, userId, bookId, extra = {}) => claimFreeCouponRedemption(current, {
  configuredCoupon: base(), userId, userKey: hash(userId), bookId, pricePaise: 7900,
  timestamp: 1_800_000_000_000, hash, ...extra
});

test("100% coupon discounts the exact price in paise", () => {
  assert.equal(couponPercent({ discountPercent: "100%" }), 100);
  assert.equal(discountPaise({ discountPercent: 100 }, 7901), 7901);
});

test("legacy seconds timestamps are normalized to milliseconds", () => {
  assert.equal(timestampMs(1_800_000_000), 1_800_000_000_000);
});

test("first redemption atomically increments usage and records entitlement claim", () => {
  const next = claim(base(), "user-a", "book-a");
  assert.equal(next.usedCount, 1);
  assert.equal(next.redemptions[hash("user-a")].bookId, "book-a");
});

test("retry for same user and book is idempotent and does not increment usage", () => {
  const first = claim(base(), "user-a", "book-a");
  const retry = claim(first, "user-a", "book-a");
  assert.equal(retry.usedCount, 1);
  assert.equal(Object.keys(retry.redemptions).length, 1);
});

test("same user cannot redeem one coupon for a different book", () => {
  const first = claim(base(), "user-a", "book-a");
  assert.equal(claim(first, "user-a", "book-b"), undefined);
});

test("usage limit prevents concurrent users from both claiming final use", () => {
  const oneUse = { ...base(), maxUses: 1 };
  const winner = claim(oneUse, "user-a", "book-a");
  assert.ok(winner);
  assert.equal(claim(winner, "user-b", "book-b"), undefined);
});

test("expired, disabled, and non-100% coupons cannot grant free access", () => {
  assert.equal(claim({ ...base(), expiresAt: 1_700_000_000_000 }, "user-a", "book-a"), undefined);
  assert.equal(claim({ ...base(), status: "DELETED" }, "user-a", "book-a"), undefined);
  assert.equal(claim({ ...base(), discountPercent: 50 }, "user-a", "book-a"), undefined);
});

test("active reservations count against the final available use", () => {
  const reserved = {
    ...base(), maxUses: 1,
    reservations: { held: { userId: "user-b", bookId: "book-b", expiresAt: 1_900_000_000_000 } }
  };
  assert.equal(claim(reserved, "user-a", "book-a"), undefined);
});
