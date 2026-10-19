"use strict";

// Firebase can call a transaction updater with null before its server value is
// available locally. Use the previously read coupon as the provisional base;
// if the server has a newer record, RTDB retries with that record.
function normalizeStatus(value) {
  return String(value || "ACTIVE").trim().toUpperCase();
}

function discountPaise(coupon, pricePaise) {
  const price = Number(pricePaise);
  const percent = couponPercent(coupon);
  if (!Number.isSafeInteger(price) || price <= 0 || !percent) return 0;
  if (percent === 100) return price;
  return Math.min(Math.floor((price * percent + 50) / 100), price);
}

function couponPercent(coupon) {
  const raw = coupon?.discountPercent ?? coupon?.discount_percentage ?? coupon?.percentage ?? coupon?.discount;
  const normalized = typeof raw === "string" ? raw.trim().replace(/%$/, "").trim() : raw;
  const percent = Number(normalized);
  return Number.isFinite(percent) && Number.isInteger(percent) && percent >= 5 && percent <= 100 ? percent : 0;
}

function timestampMs(raw) {
  if (raw == null || raw === "") return 0;
  let value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) value = Date.parse(String(raw));
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value < 1e12) value *= 1000;
  return value;
}

function expiryMs(coupon) {
  return timestampMs(coupon?.expiresAt ?? coupon?.expiry ?? coupon?.expires_at);
}

function reservationOwner(entry) {
  return String(entry?.userId ?? entry?.uid ?? entry?.userKey ?? entry?.ownerId ?? "");
}

function reservationExpiryMs(entry) {
  return timestampMs(entry?.expiresAt ?? entry?.expires_at ?? entry?.expiry);
}

function recordedUses(coupon) {
  const redemptions = coupon?.redemptions && typeof coupon.redemptions === "object" ? coupon.redemptions : {};
  return Math.max(0, Number(coupon?.usedCount || coupon?.usesCount || coupon?.redeemedCount || 0), Object.values(redemptions).filter(Boolean).length);
}

function liveReservations(coupon, timestamp, currentUserId, hash) {
  const reservations = coupon?.reservations && typeof coupon.reservations === "object" ? coupon.reservations : {};
  const currentUserKey = currentUserId ? hash(currentUserId) : "";
  const redemptions = coupon?.redemptions || {};
  return Object.values(reservations).filter(entry => {
    const owner = reservationOwner(entry);
    if (!owner || reservationExpiryMs(entry) <= timestamp) return false;
    if (currentUserId && (owner === currentUserId || owner === currentUserKey)) return false;
    const ownerKey = owner.length === 64 ? owner : hash(owner);
    return !redemptions[ownerKey] && !redemptions[owner];
  }).length;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function claimPaidCouponRedemption(current, {
  userId, userKey, bookId, orderId, timestamp, ledgerCount = 0
}) {
  if (!current || typeof current !== "object") return;
  const effective = {
    ...current,
    maxUses: firstDefined(current.maxUses, current.max_uses, current.usageLimit, current.usage_limit, current.maxRedemptions, current.totalUses),
    usedCount: firstDefined(current.usedCount, current.usesCount, current.redeemedCount, 0),
    redemptions: current.redemptions && typeof current.redemptions === "object" ? current.redemptions : {},
    reservations: current.reservations && typeof current.reservations === "object" ? current.reservations : {}
  };
  if (normalizeStatus(effective.status) !== "ACTIVE") return;
  const redemptions = { ...effective.redemptions };
  const previous = redemptions[userKey] || redemptions[userId];
  if (previous) return previous.orderId === orderId && previous.bookId === bookId ? current : undefined;
  const maxUses = Number(effective.maxUses || 0);
  const used = Math.max(recordedUses(effective), Number(ledgerCount || 0));
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || used >= maxUses) return;
  redemptions[userKey] = { userId, bookId, orderId, redeemedAt: timestamp };
  const reservations = { ...effective.reservations };
  for (const [reservationId, entry] of Object.entries(reservations)) {
    if (String(entry?.orderId || "") === String(orderId)) delete reservations[reservationId];
  }
  return { ...effective, usedCount: used + 1, redemptions, reservations };
}

function claimFreeCouponRedemption(current, {
  configuredCoupon, userId, userKey, bookId, pricePaise, timestamp, hash, ledgerCount = 0
}) {
  // A missing transaction value is a missing/deleted coupon, not permission to
  // recreate it from a stale pre-read. The route handles a cold local snapshot
  // with a one-shot provisional value after explicitly priming the reference.
  const source = current && typeof current === "object" ? current : null;
  if (!source || typeof source !== "object") return;

  const expiryValue = firstDefined(
    source.expiresAt, source.expiry, source.expires_at,
    configuredCoupon.expiresAt, configuredCoupon.expiry, configuredCoupon.expires_at
  );

  const effective = {
    ...configuredCoupon,
    ...source,
    discountPercent: firstDefined(source.discountPercent, source.discount_percentage, source.percentage, source.discount, configuredCoupon.discountPercent, configuredCoupon.discount_percentage, configuredCoupon.percentage, configuredCoupon.discount),
    maxUses: firstDefined(source.maxUses, source.max_uses, source.usageLimit, source.usage_limit, source.maxRedemptions, source.totalUses, configuredCoupon.maxUses, configuredCoupon.max_uses, configuredCoupon.usageLimit, configuredCoupon.usage_limit, configuredCoupon.maxRedemptions, configuredCoupon.totalUses),
    usedCount: firstDefined(source.usedCount, source.usesCount, source.redeemedCount, configuredCoupon.usedCount, configuredCoupon.usesCount, configuredCoupon.redeemedCount, 0),
    status: firstDefined(source.status, configuredCoupon.status, "ACTIVE"),
    // Realtime Database rejects undefined values. Null means this coupon has no expiry.
    expiresAt: expiryValue === undefined ? null : expiryValue
  };

  if (normalizeStatus(effective.status) !== "ACTIVE") return;
  const expiry = expiryMs(effective);
  if (expiry > 0 && expiry <= timestamp) return;
  if (couponPercent(effective) !== 100 || !Number.isSafeInteger(pricePaise) || pricePaise <= 0) return;

  const redemptions = { ...(effective.redemptions || {}) };
  const previous = redemptions[userKey] || redemptions[userId];
  if (previous) return previous.bookId === bookId ? effective : undefined;

  const reservations = { ...(effective.reservations || {}) };
  for (const reservationKey of Object.keys(reservations)) {
    const entry = reservations[reservationKey] || {};
    const owner = reservationOwner(entry);
    const expiresAt = reservationExpiryMs(entry);
    const ownerRedeemed = owner && (redemptions[owner] || redemptions[hash(owner)]);
    if (!owner || !expiresAt || expiresAt <= timestamp ||
        owner === userId || owner === userKey || ownerRedeemed) {
      delete reservations[reservationKey];
    }
  }

  const maxUses = Number(effective.maxUses || 0);
  const used = Math.max(recordedUses({ ...effective, redemptions }), Math.max(0, Number(ledgerCount) || 0));
  const held = liveReservations({ ...effective, redemptions, reservations }, timestamp, userId, hash);
  if (!Number.isInteger(maxUses) || maxUses < 1 || used + held >= maxUses) return;

  redemptions[userKey] = { userId, bookId, redeemedAt: timestamp };
  return { ...effective, usedCount: used + 1, redemptions, reservations };
}

module.exports = { claimFreeCouponRedemption, claimPaidCouponRedemption, couponPercent, discountPaise, timestampMs, expiryMs };
