# MS Tech EBook

Production-oriented ebook platform using one Vercel deployment, Firebase Realtime Database for application data, and Cloudflare R2 for private ebook binaries.

## Architecture

- **Frontend:** React + Vite
- **Backend:** Node.js + Express in `api/index.js`
- **Hosting:** one Vercel project
- **Database:** Firebase Realtime Database (RTDB)
- **File storage:** private Cloudflare R2 for PDF/cover binaries; Firebase Storage remains optional for legacy books
- **Authentication:** custom email/password authentication; Firebase Auth is not used
- **Payments:** Razorpay
- **Abuse protection:** Firebase RTDB transaction-backed per-IP rate limiting for authentication endpoints, so limits are shared across Vercel function instances

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
- transaction-backed per-IP authentication throttling
- Razorpay signature + captured-status + amount verification
- Razorpay webhook signature verification and reconciliation
- idempotent purchase/payment handling
- short-lived private Storage signed URLs
- security headers and HSTS
- admin audit log

Authentication endpoints use a shared RTDB-backed transaction limiter. The reader renders authorized PDF pages into a canvas without a selectable text layer or native PDF toolbar, and blocks right-click/copy/cut/save/print shortcuts while the reader is open. This is strong browser-level deterrence, not absolute DRM: anything displayed on a user's screen can still be photographed or captured.

## Vercel environment variables

Set these in the single Vercel project:

```
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_DATABASE_URL=
FIREBASE_STORAGE_BUCKET=

BUCKET=
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_ENDPOINT=

RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=


PUBLIC_ORIGIN=https://YOUR_DOMAIN
ADMIN_SETUP_KEY=
ADMIN_TOTP_SECRET=
AUTH_SESSION_SECRET=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_SENDER_EMAIL=
```

Never commit real secrets.

## Deploy

1. Import the repository into Vercel.
2. Keep the repository root as the Vercel project root; the repository's Vercel configuration routes `/api/*` to `api/index.js` and the Vite build to `frontend/dist`.
3. Add the environment variables above. For R2, `BUCKET` is the R2 bucket name and `R2_ENDPOINT` is the S3-compatible endpoint from Cloudflare. `R2_ACCESS_KEY` and `R2_SECRET_KEY` must be server-side secrets and should be scoped to Object Read & Write for this bucket. `ADMIN_SETUP_KEY` must be a strong random secret of at least 16 characters.
4. Deploy.
5. Deploy RTDB rules with Firebase CLI when needed:
   `firebase deploy --only database`
6. Configure Razorpay webhook:
   `https://YOUR_DOMAIN/api/webhooks/razorpay`
7. Test registration, login, admin TOTP, upload, free reading, paid checkout, webhook reconciliation, library access, and logout.

## Administrator portal

Admin login is available at:

- `/admin` — canonical administrator login
- `/admin/admin` — administrator login alias
- `/admin/login` — administrator login alias

After successful administrator authentication, `/admin` opens the dashboard. Customer accounts are blocked from the administrator portal.

One-time administrator initialization is at `/setadmin` and requires the private `ADMIN_SETUP_KEY`. Once initialization is completed, the setup endpoint is permanently locked.

## Admin ebook management

The admin panel supports:

- PDF upload
- cover upload
- live upload progress for each file
- protected canvas-based PDF reader with page controls and no native PDF toolbar
- FREE / PAID pricing
- metadata editing
- publish / unpublish
- deletion
- audit logging

New PDFs and covers are stored privately in Cloudflare R2. The Vercel API issues short-lived R2 presigned PUT URLs; the browser uploads directly to R2 with live progress, and the server verifies the final object size/type before creating the ebook metadata record. RTDB stores metadata, users, purchases, orders, and payment state. Firebase Storage is only retained as an optional legacy backend for books created before the R2 migration.

## Production requirements

Before accepting real customer payments:

- use a custom Vercel domain
- set `PUBLIC_ORIGIN` to the exact origin
- configure a strong admin TOTP secret
- configure the Razorpay webhook
- keep `ADMIN_SETUP_KEY` private and rotate it after initial administrator creation if desired
- rotate any credentials that were ever exposed
- keep RTDB and Storage rules closed
- back up RTDB before migrations


## Password reset by Gmail OTP

Forgot-password uses the Gmail API from the Vercel server. Google OAuth credentials stay server-side; the browser never receives the Gmail refresh token. The API sends a one-time 6-digit OTP that expires after 10 minutes, allows five verification attempts, and revokes all existing sessions after a successful password reset.

Set these Vercel environment variables:
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `GMAIL_SENDER_EMAIL`

Enable the Gmail API in Google Cloud and authorize the Gmail account that will send the messages. The implementation uses the Gmail API `messages.send` operation with OAuth 2.0 credentials. Google documents that server-side Gmail API requests require OAuth 2.0 authorization and that Gmail messages can be sent with `messages.send`. 

## Cloudflare R2 CORS

Because administrator browsers upload directly to a private R2 bucket using presigned PUT URLs, the R2 bucket must allow the deployed site origin. Cloudflare requires a bucket CORS rule for browser requests to presigned URLs.

Use this policy in **R2 → your bucket → Settings → CORS Policy** and replace the origin with your exact Vercel/custom-domain origin:

```json
[
  {
    "AllowedOrigins": ["https://ebook-one-jade.vercel.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Do not make the R2 bucket public. The application uses short-lived presigned URLs for uploads and reading.
