"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { claimFreeCouponRedemption, claimPaidCouponRedemption, couponPercent, discountPaise, timestampMs } = require("./coupon-core");

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

test("null initial Firebase transaction snapshot uses the previously read coupon", () => {
  const next = claim(null, "user-a", "book-a");
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


test("discount helper rejects invalid prices and unsupported percentages", () => {
  assert.equal(discountPaise({ discountPercent: 50 }, 0), 0);
  assert.equal(discountPaise({ discountPercent: 50 }, -100), 0);
  assert.equal(discountPaise({ discountPercent: 101 }, 7900), 0);
  assert.equal(discountPaise({ discountPercent: 50 }, 7900), 3950);
});

test("discount helper rounds fractional paise deterministically and never exceeds price", () => {
  assert.equal(discountPaise({ discountPercent: 5 }, 101), 5);
  assert.equal(discountPaise({ discountPercent: 99 }, 101), 100);
  assert.equal(discountPaise({ discountPercent: 100 }, 101), 101);
});

test("expired reservations do not block the final coupon use", () => {
  const coupon = {
    ...base(), maxUses: 1,
    reservations: { old: { userId: "user-b", bookId: "book-b", expiresAt: 1_700_000_000_000 } }
  };
  const next = claim(coupon, "user-a", "book-a");
  assert.ok(next);
  assert.equal(next.usedCount, 1);
});


test("paid coupon finalization atomically converts its reservation to one redemption", () => {
  const partial = { ...base(), discountPercent: 25, maxUses: 1, reservations: {
    [hash("user-a")]: { userId: "user-a", bookId: "book-a", expiresAt: 1_900_000_000_000 }
  }};
  const next = claimPaidCouponRedemption(partial, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a", orderId: "order-a",
    timestamp: 1_800_000_000_000, hash
  });
  assert.equal(next.usedCount, 1);
  assert.equal(next.redemptions[hash("user-a")].orderId, "order-a");
  assert.equal(Object.keys(next.reservations).length, 0);
});

test("paid coupon cannot exceed maxUses after its reservation expires and another user takes the slot", () => {
  const partial = { ...base(), discountPercent: 25, maxUses: 1, usedCount: 1,
    redemptions: { [hash("user-b")]: { userId: "user-b", bookId: "book-b" } },
    reservations: {}
  };
  assert.equal(claimPaidCouponRedemption(partial, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a", orderId: "order-a",
    timestamp: 1_800_000_000_000, hash
  }), undefined);
});

test("paid coupon finalization retry is idempotent for the same user and book", () => {
  const partial = { ...base(), discountPercent: 25, maxUses: 1, reservations: {
    [hash("user-a")]: { userId: "user-a", bookId: "book-a", expiresAt: 1_900_000_000_000 }
  }};
  const first = claimPaidCouponRedemption(partial, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a", orderId: "order-a",
    timestamp: 1_800_000_000_000, hash
  });
  const retry = claimPaidCouponRedemption(first, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a", orderId: "order-a",
    timestamp: 1_800_000_000_100, hash
  });
  assert.equal(retry.usedCount, 1);
  assert.equal(Object.keys(retry.redemptions).length, 1);
});


test("API imports the paid coupon helper used by payment finalization", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(apiSource, /claimPaidCouponRedemption\s*\}\s*=\s*require\(["']\.\/coupon-core["']\)/);
  assert.match(apiSource, /claimPaidCouponRedemption\(current/);
});

test("zero-value order checkout uses the shared free-redemption transaction", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const routeStart = apiSource.indexOf('router.post("/orders/create"');
  const routeEnd = apiSource.indexOf("async function finalizePayment", routeStart);
  const route = apiSource.slice(routeStart, routeEnd);
  const freeStart = route.indexOf("if (coupon && pricePaise === 0)");
  const freeEnd = route.indexOf("// Recover an unpaid order", freeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart && freeStart >= 0 && freeEnd > freeStart);
  const freeCheckout = route.slice(freeStart, freeEnd);
  assert.match(freeCheckout, /claimFreeCouponRedemption\(current/);
  assert.doesNotMatch(freeCheckout, /usedCount\s*:\s*Number/);
});
