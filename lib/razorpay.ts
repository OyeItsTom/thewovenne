import Razorpay from "razorpay";

// Fall back to placeholder values so the app can build before Razorpay
// credentials are configured. The SDK validates these at construction time,
// unlike Stripe's client. Real requests will fail gracefully until valid
// env vars are provided.
export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_placeholder",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "placeholder-secret",
});
