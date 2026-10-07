# MS Tech EBook

Firebase-backed ebook platform with manual server-side authentication.

## Authentication

Firebase Authentication is NOT used.

The authentication model uses:
- Node.js/Express backend
- Email + password registration/login
- Server-side scrypt password hashing
- Opaque random sessions stored in Firestore
- HttpOnly, Secure, SameSite session cookie
- Session expiry and server-side revocation
- Blocked-account checks
- CSRF protection and same-origin checks
- Redis-backed rate limits

The browser never talks to Firebase Auth.

## Data and files

- Firestore is the application database.
- Firebase Storage contains private ebook files.
- Firestore client rules are closed; backend uses Firebase Admin SDK.
- Storage client rules are closed; backend creates short-lived signed URLs.

## Security

- Redis/Upstash rate limiting
- Payment replay protection
- Razorpay signature verification
- Razorpay captured-status and amount verification
- Duplicate order protection
- Private ebook storage
- Five-minute signed ebook URLs
- HSTS and security headers
- Reader copy/right-click/selection/save/print/source blocking

Browser anti-copy controls are deterrence, not DRM. Visible browser content cannot be made literally impossible to screenshot or extract.

## Environment

Functions environment variables:
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
PUBLIC_ORIGIN=https://your-domain.com
AUTH_SESSION_SECRET=generate_a_long_random_secret
ADMIN_OTP_SECRET=generate_a_separate_long_random_secret

Never commit real secrets.

## Deploy

npm run install-all
npm run build
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy

Hosting routes /api/** to the manual-auth backend.

## Ebook management

Admin can upload PDF ebooks and cover images through the protected admin panel. Each ebook can be marked FREE or PAID. Free ebooks require no Razorpay payment and are automatically available in the signed-url reader; paid ebooks require a verified Razorpay payment. Admins can edit metadata, publish/unpublish, and permanently delete ebooks.

## Production follow-up

Before launch, add admin OTP authentication, account-recovery OTP, audit logging, and Razorpay webhook reconciliation. The core manual user authentication, session, payment, ownership, and secure ebook access path is server-side.
