// POST /api/billing {action:"start"}  -> creates Razorpay order with UPI AutoPay mandate
// POST /api/billing {action:"verify", razorpay_payment_id, razorpay_order_id, razorpay_signature}
const crypto = require('crypto');
const {
  env, send, readJson, requireAccount, dbGet, dbInsert, dbUpdate,
  rzp, activateAccount, todayIST, BASE_PRICE, MANDATE_MAX, APP_NAME
} = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const account = await requireAccount(req, res);
    if (!account) return;
    const b = await readJson(req);

    if (b.action === 'start') {
      if (!account.name || !account.phone) {
        return send(res, 400, { error: 'Add your name and mobile number in Settings first' });
      }
      if (account.billing_status === 'active' && account.rzp_token_id) {
        return send(res, 400, { error: 'AutoPay is already active' });
      }

      // Unpaid dues from an older cancelled mandate are collected first.
      const failed = await dbGet('charges', 'user_id=eq.' + account.id + '&kind=eq.milestone&status=eq.failed&select=amount');
      const dues = failed.reduce((s, c) => s + (c.amount || 0), 0);
      const amount = BASE_PRICE + dues;

      let customerId = account.rzp_customer_id;
      if (!customerId) {
        const c = await rzp('/customers', 'POST', {
          name: account.name,
          email: account.email,
          contact: account.phone,
          fail_existing: '0'
        });
        customerId = c.id;
        await dbUpdate('accounts', 'id=eq.' + account.id, { rzp_customer_id: customerId });
      }

      const order = await rzp('/orders', 'POST', {
        amount: amount * 100,
        currency: 'INR',
        customer_id: customerId,
        method: 'upi',
        receipt: ('reg_' + account.id).slice(0, 40),
        notes: { user_id: account.id, kind: 'base' },
        token: {
          max_amount: MANDATE_MAX * 100,
          expire_at: Math.floor(Date.now() / 1000) + 5 * 365 * 86400,
          frequency: 'as_presented'
        }
      });

      await dbInsert('charges', {
        user_id: account.id,
        kind: 'base',
        amount: amount,
        for_cycle_start: todayIST(),
        rzp_order_id: order.id,
        status: 'created',
        note: dues ? 'includes old dues Rs ' + dues : 'mandate registration'
      });

      return send(res, 200, {
        key: env('RAZORPAY_KEY_ID', ''),
        order_id: order.id,
        customer_id: customerId,
        amount: amount,
        dues: dues,
        app_name: APP_NAME,
        prefill: { name: account.name, email: account.email, contact: account.phone }
      });
    }

    if (b.action === 'verify') {
      const body = String(b.razorpay_order_id) + '|' + String(b.razorpay_payment_id);
      const expected = crypto.createHmac('sha256', env('RAZORPAY_KEY_SECRET', '')).update(body).digest('hex');
      if (expected !== b.razorpay_signature) return send(res, 400, { error: 'Payment verification failed' });

      const charge = await dbGet('charges', 'rzp_order_id=eq.' + b.razorpay_order_id + '&user_id=eq.' + account.id + '&select=id');
      if (!charge.length) return send(res, 400, { error: 'Unknown order' });

      const p = await rzp('/payments/' + b.razorpay_payment_id, 'GET');
      await dbUpdate('charges', 'rzp_order_id=eq.' + b.razorpay_order_id, { rzp_payment_id: p.id });
      if (!p.token_id) {
        return send(res, 200, { ok: true, pending: true, message: 'Payment received. AutoPay confirmation is pending, it will activate in a few minutes.' });
      }
      await activateAccount(account.id, p.token_id, b.razorpay_order_id);
      return send(res, 200, { ok: true });
    }

    send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
