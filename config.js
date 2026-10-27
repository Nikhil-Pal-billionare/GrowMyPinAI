// Public config for the browser (only public keys here, never secrets)
const { env, send, BASE_PRICE, MILESTONES, APP_NAME } = require('./_lib');

module.exports = async (req, res) => {
  send(res, 200, {
    appName: APP_NAME,
    supabaseUrl: env('SUPABASE_URL', ''),
    supabaseAnonKey: env('SUPABASE_ANON_KEY', ''),
    razorpayKeyId: env('RAZORPAY_KEY_ID', ''),
    basePrice: BASE_PRICE,
    milestones: MILESTONES.slice().reverse()
  });
};
