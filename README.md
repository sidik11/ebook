# MS Tech EBook

Secure Firebase ebook store for **MS Tech EBook**.

## Stack

- React + Vite frontend
- Firebase Authentication
- Firebase App Check (reCAPTCHA v3)
- Cloud Firestore
- Private Firebase Storage
- Firebase Cloud Functions
- Upstash Redis REST API for rate limiting and replay protection
- Razorpay payment verification
- Firebase Hosting security headers

## Security architecture

1. Firebase Auth identifies the user.
2. Firebase App Check helps reject non-genuine app traffic.
3. Cloud Functions are the trusted backend for payment and ebook access.
4. Firestore purchase documents cannot be created by clients.
5. Redis rate-limits sensitive callable functions.
6. Redis prevents duplicate payment processing and concurrent order creation.
7. Razorpay payment signatures are verified server-side.
8. The backend checks Razorpay payment status and exact captured amount.
9. Ebooks are stored privately.
10. A purchased ebook is served through a short-lived signed URL (5 minutes).
11. The reader disables context menu, selection, copy/cut and common save/print/source shortcuts.
12. Hosting sends security headers including HSTS, CSP-adjacent browser protections, X-Content-Type-Options and Referrer-Policy.

Browser anti-copy controls are deterrents, not DRM. No web application can guarantee that content visible to a user is impossible to copy or screenshot.

## Required environment variables

### Frontend

Copy `frontend/.env.example` to `frontend/.env` and configure:

- Firebase web app configuration
- `VITE_FIREBASE_APPCHECK_SITE_KEY`

### Cloud Functions

Copy `functions/.env.example` to `functions/.env` and configure:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Never commit real secrets.

## Deployment

```bash
npm run install-all
npm run build
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy
```

Enable in Firebase:

- Authentication → Email/Password
- Firestore
- Storage
- App Check for the web app

Create an Upstash Redis database and use its REST URL/token.

Create/configure your Razorpay account and keep the secret key only in Functions environment variables.

## Admin

After an admin user exists, assign the Firebase custom claim:

```bash
node functions/set-admin.js admin@example.com
```

The admin claim is `admin=true`. Never expose service-account credentials in the frontend or GitHub.

## Production checklist

- Use production Razorpay keys only in Functions secrets/environment.
- Configure Razorpay webhooks and reconcile webhook events server-side.
- Keep ebook Storage files private.
- Use App Check enforcement in production.
- Rotate Redis/Razorpay credentials if they are ever exposed.
- Do not upload `.env` files or service-account JSON to Git.
- Test purchase, refund, duplicate callback, expired signed URL and unauthorized reader access before launch.
