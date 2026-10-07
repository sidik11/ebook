# MS Tech EBook

Firebase ebook store for MS Tech EBook.

Stack: React/Vite, Firebase Authentication, Firestore, Firebase Storage, Cloud Functions, Firebase Hosting, Razorpay-ready payments.

Security: ebooks are private in Storage and access is controlled by purchase ownership. The reader disables right-click, selection, copy, common save/print shortcuts and visible PDF toolbar controls. This is a deterrent, not DRM: a browser cannot make readable content literally impossible to copy.

Setup:
1. Create a Firebase project.
2. Enable Email/Password Authentication, Firestore and Storage.
3. Copy frontend/.env.example to frontend/.env and fill Firebase values.
4. Copy functions/.env.example to functions/.env and fill Razorpay values.
5. Run npm run install-all.
6. Run npm run build.
7. Deploy with firebase deploy.

Admin: after a user exists, run node functions/set-admin.js admin@example.com with Firebase Admin credentials available to the script. Never commit service-account JSON or real secrets.

For production, configure a Razorpay webhook and reconcile payment status server-side.