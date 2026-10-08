# MS Tech EBook

Production-oriented ebook platform using one Vercel deployment, one Firebase project, and Firebase Realtime Database.

## Architecture

- **Frontend:** React + Vite
- **Backend:** Node.js + Express in `api/index.js`
- **Hosting:** one Vercel project
- **Database:** Firebase Realtime Database (RTDB)
- **File storage:** private Firebase Storage for PDF/cover binaries only
- **Authentication:** custom email/password authentication; Firebase Auth is not used
- **Payments:** Razorpay
- **Rate limiting:** Upstash Redis

There is no Firestore dependency and no Firebase Functions backend.

## RTDB model

```
users/{sha256(email)}
sessions/{sha256(sessionToken)}
books/{bookId}
purchases/{sha256(userId:bookId)}
orders/{razorpayOrderId}
paymentEvents/{razorpayPaymentId}
auditLogs/{auditId}
```

All client RTDB reads/writes are denied. The Vercel API uses Firebase Admin SDK credentials.

## Security

- scrypt password hashing
- opaque random session tokens stored server-side
- HttpOnly + Secure + SameSite cookies
- CSRF token validation on state-changing authenticated requests
- current RTDB user record is the source of truth for admin authorization
- optional admin TOTP verification
- Redis rate limits
- Razorpay signature + captured-status + amount verification
- Razorpay webhook signature verification and reconciliation
- idempotent purchase/payment handling
- short-lived private Storage signed URLs
- security headers and HSTS
- admin audit log

Browser copy/right-click/print controls are only deterrence. A PDF delivered to a browser cannot be made literally impossible to screenshot or extract.

## Vercel environment variables

Set these in the single Vercel project:

```
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_DATABASE_URL=
FIREBASE_STORAGE_BUCKET=

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

PUBLIC_ORIGIN=https://YOUR_DOMAIN
ADMIN_TOTP_SECRET=
```

Never commit real secrets.

## Deploy

1. Import the repository into Vercel.
2. Keep the repository root as the Vercel project root.
3. Add the environment variables above.
4. Deploy.
5. Deploy RTDB rules with Firebase CLI when needed:
   `firebase deploy --only database`
6. Configure Razorpay webhook:
   `https://YOUR_DOMAIN/api/webhooks/razorpay`
7. Test registration, login, admin TOTP, upload, free reading, paid checkout, webhook reconciliation, library access, and logout.

## Admin ebook management

The admin panel supports:

- PDF upload
- cover upload
- FREE / PAID pricing
- metadata editing
- publish / unpublish
- deletion
- audit logging

PDFs and covers remain private in Firebase Storage. RTDB stores metadata and authorization/payment state.

## Production requirements

Before accepting real customer payments:

- use a custom Vercel domain
- set `PUBLIC_ORIGIN` to the exact origin
- configure a strong admin TOTP secret
- configure the Razorpay webhook
- configure Upstash Redis
- rotate any credentials that were ever exposed
- keep RTDB and Storage rules closed
- back up RTDB before migrations
