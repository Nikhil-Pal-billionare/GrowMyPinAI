// Razorpay webhook. In Razorpay Dashboard -> Webhooks, point to:
//   https://YOUR-APP.vercel.app/api/razorpay-webhook
// Events: payment.captured, payment.failed, token.confirmed,
//         token.cancelled, token.paused, token.rejected
const crypto = require('crypto');
const { env, send, readRaw, dbGet, dbUpdate, activateAccount } = require('./_lib');

async function rawBody(req) {
  // Read the untouched body for signature check.
  const raw = await Promise.race([
    readRaw(req),
    new Promise((r) => setTimeout(() => r(''), 3000))
  ]);
  if (raw) return raw;
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

async function unpauseIfClear(userId) {
  const pending = await dbGet('charges', 'user_id=eq.' + userId +
    '&kind=eq.milestone&status=in.(created,pending,failed)&select=id&limit=1');
  if (!pending.length) {
    const acc = (await dbGet('accounts', 'id=eq.' + userId + '&select=billing_status'))[0];
    if (acc && acc.billing_status === 'active') {
      await dbUpdate('accounts', 'id=eq.' + userId, { posting_paused: false });
    }
  }
}

module.exports = async (req, res) => {
  try {
    const raw = await rawBody(req);
    const sig = req.headers['x-razorpay-signature'] || '';
    const expected = crypto.createHmac('sha256', env('RAZORPAY_WEBHOOK_SECRET', '')).update(raw).digest('hex');
    if (!sig || sig !== expected) return send(res, 400, { error: 'bad signature' });

    const evt = JSON.parse(raw);
    const event = evt.event;
    const payload = evt.payload || {};

    if (event === 'payment.captured' || event === 'payment.failed') {
      const p = payload.payment && payload.payment.entity;
      if (!p || !p.order_id) return send(res, 200, { ok: true });
      const rows = await dbGet('charges', 'rzp_order_id=eq.' + p.order_id + '&select=*');
      const charge = rows[0];
      if (!charge) return send(res, 200, { ok: true, note: 'unknown order' });

      if (event === 'payment.captured') {
        if (charge.status !== 'captured') {
          await dbUpdate('charges', 'id=eq.' + charge.id, { status: 'captured', rzp_payment_id: p.id });
        }
        const acc = (await dbGet('accounts', 'id=eq.' + charge.user_id + '&select=*'))[0];
        // First payment of a new mandate (checkout page may have been closed early)
        if (acc && p.token_id && (acc.billing_status !== 'active' || !acc.rzp_token_id)) {
          await activateAccount(charge.user_id, p.token_id, p.order_id);
        } else if (charge.kind === 'milestone') {
          await unpauseIfClear(charge.user_id);
        }
      } else {
        if (charge.status !== 'captured') {
          await dbUpdate('charges', 'id=eq.' + charge.id, {
            status: 'failed',
            rzp_payment_id: p.id,
            note: String(p.error_description || 'payment failed').slice(0, 300)
          });
          if (charge.kind === 'milestone') {
            await dbUpdate('accounts', 'id=eq.' + charge.user_id, { posting_paused: true, billing_status: 'past_due' });
          }
        }
      }
      return send(res, 200, { ok: true });
    }

    if (event && event.indexOf('token.') === 0) {
      const t = payload.token && payload.token.entity;
      if (!t) return send(res, 200, { ok: true });
      let accs = await dbGet('accounts', 'rzp_token_id=eq.' + t.id + '&select=id');
      if (!accs.length && t.customer_id) {
        accs = await dbGet('accounts', 'rzp_customer_id=eq.' + t.customer_id + '&select=id,rzp_token_id');
      }
      const acc = accs[0];
      if (!acc) return send(res, 200, { ok: true });

      if (event === 'token.cancelled' || event === 'token.paused' || event === 'token.rejected') {
        // Mandate stopped by the customer: lock posting, keep dues on record.
        await dbUpdate('accounts', 'id=eq.' + acc.id, {
          billing_status: 'locked',
          posting_paused: true,
          rzp_token_id: null
        });
        // Earned milestone money stays as dues; an unused next-cycle base charge is dropped.
        await dbUpdate('charges', 'user_id=eq.' + acc.id + '&kind=eq.milestone&status=in.(created,pending)', {
          status: 'failed',
          note: 'mandate ' + event.replace('token.', '')
        });
        await dbUpdate('charges', 'user_id=eq.' + acc.id + '&kind=eq.base&status=in.(created,pending)', {
          status: 'cancelled',
          note: 'mandate ' + event.replace('token.', '')
        });
      }
      if (event === 'token.confirmed' && !acc.rzp_token_id) {
        await dbUpdate('accounts', 'id=eq.' + acc.id, { rzp_token_id: t.id });
      }
      return send(res, 200, { ok: true });
    }

    send(res, 200, { ok: true, ignored: event });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
