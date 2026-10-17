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

test("missing transaction value never recreates a coupon from a stale pre-read", () => {
  assert.equal(claim(null, "user-a", "book-a"), undefined);
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

test("free redemption counts historical ledger-only uses when aggregate counts are stale", () => {
  const coupon = { ...base(), maxUses: 2, usedCount: 0, redemptions: {} };
  assert.equal(claimFreeCouponRedemption(coupon, {
    configuredCoupon: base(), userId: "user-new", userKey: hash("user-new"),
    bookId: "book-new", pricePaise: 7900, timestamp: 1_800_000_000_000,
    hash, ledgerCount: 2
  }), undefined);
});

test("free redemption can claim remaining use when ledger count is below limit", () => {
  const coupon = { ...base(), maxUses: 2, usedCount: 0, redemptions: {} };
  const next = claimFreeCouponRedemption(coupon, {
    configuredCoupon: base(), userId: "user-new", userKey: hash("user-new"),
    bookId: "book-new", pricePaise: 7900, timestamp: 1_800_000_000_000,
    hash, ledgerCount: 1
  });
  assert.ok(next);
  assert.equal(next.usedCount, 2);
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


test("paid checkout primes the coupon reference and retries one transient reservation abort", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const routeStart = apiSource.indexOf('router.post("/orders/create"');
  const routeEnd = apiSource.indexOf("async function finalizePayment", routeStart);
  const route = apiSource.slice(routeStart, routeEnd);
  const prime = route.indexOf('await couponRef.once("value")');
  const transaction = route.indexOf("const reserveCoupon = () => couponRef.transaction");
  const retry = route.indexOf("let couponTx = await reserveCoupon()");
  assert.ok(prime >= 0 && transaction > prime && retry > transaction);
  assert.match(route.slice(retry, retry + 700), /const retrySnapshot = await couponRef\.once\("value"\)/);
});


test("coupon reservation 503 includes safe diagnostic reason and logs transaction state", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(apiSource, /abortReason: reservationAbortReason/);
  assert.match(apiSource, /code: "COUPON_RESERVATION_FAILED"/);
  assert.match(apiSource, /Coupon reservation transaction did not commit after retry/);
  assert.match(apiSource, /coupon_missing_in_transaction/);
  assert.match(apiSource, /usage_limit_or_reservation_capacity/);
});


test("reservation transaction uses the pre-read coupon for one null local snapshot only", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(apiSource, /let usedProvisionalCoupon = false/);
  assert.match(apiSource, /if \(!usedProvisionalCoupon && coupon && typeof coupon === "object"\)/);
  assert.match(apiSource, /usedProvisionalCoupon = true/);
  assert.match(apiSource, /reservationAbortReason = "coupon_missing_in_transaction"/);
});


test("paid checkout creates a Razorpay order for the exact discounted amount", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const routeStart = source.indexOf('router.post("/orders/create"');
  const routeEnd = source.indexOf("async function finalizePayment", routeStart);
  const route = source.slice(routeStart, routeEnd);
  const orderCreate = route.indexOf("const order = await razorpay.orders.create({");
  assert.ok(orderCreate >= 0);
  assert.match(route.slice(orderCreate, orderCreate + 700), /amount: pricePaise, currency: "INR"/);
  assert.match(route, /amountPaise: order\.amount/);
  assert.match(route, /couponCode: coupon \? couponCode : ""/);
  assert.match(route, /originalAmount: Number\(book\.price\), discount: discountRupees/);
});


test("captured payment ledger is persisted before coupon bookkeeping", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = apiSource.indexOf("async function finalizePayment");
  const end = apiSource.indexOf('router.post("/orders/verify"', start);
  const finalize = apiSource.slice(start, end);
  const ledgerWrite = finalize.indexOf("await db.ref().update(updates)");
  const couponAccounting = finalize.indexOf('const usePath = "couponUses/"');
  assert.ok(ledgerWrite >= 0 && couponAccounting > ledgerWrite);
  assert.match(finalize, /couponAccountingStatus: "RETRY_REQUIRED"/);
  assert.match(finalize, /paymentMethod: paymentMethod/);
});

test("admin payment ledger exposes coupon discount, payment method, and captured time", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = apiSource.indexOf('router.get("/admin/orders"');
  const end = apiSource.indexOf('router.patch("/admin/books/:id"', start);
  const endpoint = apiSource.slice(start, end);
  assert.match(endpoint, /originalAmount: Number\(order\.originalAmount/);
  assert.match(endpoint, /couponCode: safeText\(order\.couponCode/);
  assert.match(endpoint, /paymentMethod: safeText\(order\.paymentMethod/);
  assert.match(endpoint, /paymentCapturedAt: Number\(order\.paymentCapturedAt/);
});


test("coupon validation and checkout enforce usage from the per-user redemption ledger", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const validateStart = source.indexOf('router.post("/coupons/validate"');
  const validateEnd = source.indexOf('router.post("/coupons/redeem-free"', validateStart);
  const validateRoute = source.slice(validateStart, validateEnd);
  assert.match(validateRoute, /get\("couponUses\/" \+ code\)/);
  assert.match(validateRoute, /couponRecordedUses\(canonical, ledgerUseCount\)/);

  const createStart = source.indexOf('router.post("/orders/create"');
  const createEnd = source.indexOf("async function finalizePayment", createStart);
  const createRoute = source.slice(createStart, createEnd);
  assert.match(createRoute, /get\("couponUses\/" \+ couponCode\)/);
  assert.match(createRoute, /couponRecordedUses\(effective, couponLedgerUseCount\)/);
});


test("paid redemption atomically claims the last use and rejects a second account", () => {
  const coupon = { ...base(), discountPercent: 50, maxUses: 1 };
  const first = claimPaidCouponRedemption(coupon, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a",
    orderId: "order-a", timestamp: 1_800_000_000_000, ledgerCount: 0
  });
  assert.ok(first);
  assert.equal(first.usedCount, 1);
  assert.equal(first.redemptions[hash("user-a")].orderId, "order-a");
  assert.equal(claimPaidCouponRedemption(first, {
    userId: "user-b", userKey: hash("user-b"), bookId: "book-b",
    orderId: "order-b", timestamp: 1_800_000_000_001, ledgerCount: 0
  }), undefined);
});

test("paid redemption is idempotent for the same order and refuses another order for the same account", () => {
  const first = claimPaidCouponRedemption({ ...base(), discountPercent: 50 }, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a",
    orderId: "order-a", timestamp: 1_800_000_000_000, ledgerCount: 0
  });
  assert.equal(claimPaidCouponRedemption(first, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a",
    orderId: "order-a", timestamp: 1_800_000_000_001, ledgerCount: 1
  }), first);
  assert.equal(claimPaidCouponRedemption(first, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a",
    orderId: "order-other", timestamp: 1_800_000_000_002, ledgerCount: 1
  }), undefined);
});

test("paid redemption includes ledger-only uses when enforcing maxUses", () => {
  const coupon = { ...base(), discountPercent: 50, maxUses: 2, usedCount: 0 };
  assert.equal(claimPaidCouponRedemption(coupon, {
    userId: "user-a", userKey: hash("user-a"), bookId: "book-a",
    orderId: "order-a", timestamp: 1_800_000_000_000, ledgerCount: 2
  }), undefined);
});

test("abandon and expiry cleanup only release reservations linked to that exact order", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(source, /String\(entry\?\.orderId \|\| ""\) === providerId/);
  assert.match(source, /String\(entry\?\.orderId \|\| ""\) === String\(order\.razorpayOrderId \|\| orderId\)/);
  assert.match(source, /collectOrders\(legacySnapshot, "order"\)/);
  assert.match(source, /devModeEnabled = \/\^\(1\|true\|yes\|on\)\$\/i/);
});


test("paid order endpoint cannot independently grant 100% coupon access", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = source.indexOf('router.post("/orders/create"');
  const end = source.indexOf("async function finalizePayment", start);
  const route = source.slice(start, end);
  const rejectFree = route.indexOf("if (couponPercent(coupon) === 100)");
  const reserve = route.indexOf("const reserveCoupon = () => couponRef.transaction");
  assert.ok(rejectFree >= 0 && reserve > rejectFree);
  assert.doesNotMatch(route, /if \(coupon && pricePaise === 0\)/);
  assert.doesNotMatch(route, /status: "PAID", purchasedAt: now\(\)/);
});

test("free redemption uses full ledger count and only one provisional transaction callback", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = source.indexOf('router.post("/coupons/redeem-free"');
  const end = source.indexOf('router.get("/admin/coupons"', start);
  const route = source.slice(start, end);
  assert.match(route, /Object\.keys\(couponUsesLedger\)\.length/);
  assert.match(route, /let firstCouponTransactionCall = true/);
  assert.match(route, /if \(!isFirstCall \|\| !configuredCoupon/);
  assert.match(route, /ledgerCount: couponLedgerUseCount/);
});

test("admin analytics excludes cancelled and review-required orders and uses local date labels", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(source, /\["PAID", "DUPLICATE_CAPTURED", "SUPERSEDED", "CANCELLED", "REVIEW_REQUIRED"\]/);
  assert.match(source, /day\.getMonth\(\) \+ 1/);
  assert.doesNotMatch(source, /dailyRevenue\.push\(\{ date: day\.toISOString\(\)\.slice\(5, 10\)/);
});

test("admin order endpoint and panel expose offset pagination", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const apiSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = apiSource.indexOf('router.get("/admin/orders"');
  const end = apiSource.indexOf('router.patch("/admin/orders/:id/terminate"', start);
  const endpoint = apiSource.slice(start, end);
  assert.match(endpoint, /Number\.parseInt\(req\.query\.offset, 10\)/);
  assert.match(endpoint, /hasMore: offset \+ orders\.length < totalOrders/);
  const panel = fs.readFileSync(path.join(__dirname, "../frontend/src/AdminPanel.jsx"), "utf8");
  assert.match(panel, /loadMoreOrders/);
  assert.match(panel, /offset=" \+ ordersNextOffset/);
});
