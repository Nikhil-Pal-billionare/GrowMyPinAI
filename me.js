// GET  /api/me  -> account, stats, recent pins, charges
// POST /api/me  -> update settings {name, phone, platform, store_url, niche, board_ids}
const {
  send, readJson, requireAccount, dbGet, dbUpdate,
  milestoneFor, nextMilestone, BASE_PRICE
} = require('./_lib');

function publicAccount(a) {
  return {
    email: a.email,
    name: a.name,
    phone: a.phone,
    platform: a.platform,
    store_url: a.store_url,
    niche: a.niche,
    pins_per_day: a.pins_per_day,
    pinterest_connected: !!a.pin_access_token,
    pin_username: a.pin_username,
    board_ids: a.board_ids || [],
    billing_status: a.billing_status,
    posting_paused: a.posting_paused,
    mandate_active: !!a.rzp_token_id && a.billing_status !== 'locked',
    cycle_start: a.cycle_start,
    cycle_end: a.cycle_end,
    cycle_views: a.cycle_views || 0,
    milestone_charged: a.milestone_charged || 0
  };
}

module.exports = async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;

    if (req.method === 'POST') {
      const b = await readJson(req);
      const patch = {};
      if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 80);
      if (typeof b.phone === 'string') patch.phone = b.phone.replace(/[^0-9+]/g, '').slice(0, 15);
      if (b.platform === 'shopify' || b.platform === 'etsy') patch.platform = b.platform;
      if (typeof b.store_url === 'string') patch.store_url = b.store_url.trim().slice(0, 300);
      if (typeof b.niche === 'string') patch.niche = b.niche.trim().slice(0, 120);
      if (Array.isArray(b.board_ids)) patch.board_ids = b.board_ids.map(String).slice(0, 10);
      const rows = await dbUpdate('accounts', 'id=eq.' + account.id, patch);
      return send(res, 200, { ok: true, account: publicAccount(rows[0]) });
    }

    const [products, jobs, charges] = await Promise.all([
      dbGet('products', 'user_id=eq.' + account.id + '&select=id&limit=1000'),
      dbGet('pin_jobs', 'user_id=eq.' + account.id +
        '&select=id,run_date,run_at,status,title,image_url,style,error,pinterest_pin_id' +
        '&order=run_at.desc&limit=30'),
      dbGet('charges', 'user_id=eq.' + account.id +
        '&select=kind,amount,status,created_at,for_cycle_start&order=created_at.desc&limit=20')
    ]);

    const views = account.cycle_views || 0;
    const due = milestoneFor(views);
    const next = nextMilestone(views);

    send(res, 200, {
      account: publicAccount(account),
      stats: {
        product_count: products.length,
        pins_posted: jobs.filter((j) => j.status === 'posted').length,
        base_price: BASE_PRICE,
        current_milestone: due,
        next_milestone: next,
        this_cycle_total: BASE_PRICE + Math.max(due, account.milestone_charged || 0)
      },
      jobs,
      charges
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
