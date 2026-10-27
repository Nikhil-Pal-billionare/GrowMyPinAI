// The engine. Called every 15 minutes by GitHub Actions (see .github/workflows/worker.yml).
//   1. Once a day per user: roll billing cycle, fetch Pinterest views,
//      trigger milestone / renewal debits, queue today's pins.
//   2. Every run: make + post the pins that are due (as many as time allows).
const {
  env, send, db, dbGet, dbUpdate, uploadImage, pinApi,
  todayIST, addDays, daysBetween, chargeMandate,
  milestoneFor, BASE_PRICE
} = require('./_lib');

const PAUSE_ON_PENDING = env('PAUSE_ON_PENDING', '1') === '1';
const STYLES = ['text_band', 'gift_recipient', 'curiosity_hook', 'lifestyle', 'luxury_glow'];

const STYLE_GUIDE = {
  text_band: 'Vertical 2:3 pin split in three: top a lifestyle photo of the product, middle a solid color band with the overlay text in big bold clean font, bottom a close-up detail shot of the product.',
  gift_recipient: 'Warm, cozy, glowing gift scene (soft golden lights, gift wrap, festive but tasteful). Overlay text names who it is a gift for, e.g. "Gift for Mom".',
  curiosity_hook: 'Product hero shot with a big bold curiosity hook overlay text readable from far away, high contrast, minimal background.',
  lifestyle: 'Product in real everyday use in a beautiful real-life setting, natural window light, no text on image.',
  luxury_glow: 'Premium editorial scene, luxury glowing interior or styled flat lay, rich soft shadows, magazine quality, no clutter, small overlay text or none.'
};

function seasonHint(dateStr) {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  if (m === 10) return 'October: holiday gift-ideas peak on Pinterest, people are saving Christmas and Diwali gift ideas.';
  if (m === 11) return 'November: highest buying intent month, Black Friday and Christmas gift shopping.';
  if (m === 12 && d <= 20) return 'December 1-20: last-minute Christmas gifts, fast delivery, stocking stuffers.';
  if (m === 12 || m === 1) return 'New year: fresh start, resolutions, organization, self-care.';
  if (m === 2) return 'February: Valentines Day gifts and love themes.';
  if (m === 3 || m === 4) return 'Spring: spring refresh, Easter, Mothers Day planning starts.';
  if (m === 5) return 'May: Mothers Day gifts, summer planning, graduation gifts.';
  if (m === 6) return 'June: Fathers Day gifts, summer, weddings.';
  if (m === 7 || m === 8) return 'Summer: back to school, early holiday planners start saving Christmas ideas.';
  return 'September: fall and Halloween, holiday searches start rising.';
}

// ---------- AI ----------
async function writePinText(account, product, style, dateStr) {
  const prompt = [
    'You write Pinterest pins that sell products from Etsy and Shopify stores to US buyers with high buying intent.',
    '',
    'Product title: ' + product.title,
    'Product description: ' + String(product.description || '').slice(0, 700),
    'Price: ' + (product.price || 'n/a'),
    'Store niche: ' + (account.niche || 'general'),
    'Season: ' + seasonHint(dateStr),
    'Pin style: ' + style + ' - ' + STYLE_GUIDE[style],
    '',
    'Rules:',
    '- Title: max 95 characters, start with the main search keyword, buyer intent words (gift, for her, decor idea etc.) where natural. No ALL CAPS, no emojis.',
    '- Description: 2-3 short natural sentences, max 450 characters, SEO first not storytelling, one clear theme only, use only 4-5 light keywords. Never stuff keywords, never mix unrelated occasions, no hashtags, no emojis. End with a soft call to action like "Tap to shop".',
    '- Alt text: plain description of what the image shows, max 300 characters.',
    '- overlay_text: max 6 words for the image (empty string for lifestyle style).',
    '- image_prompt: detailed scene for an AI image model, vertical 2:3, the exact product as the hero, excellent lighting and realistic shadows, photorealistic. If overlay_text is not empty, say the image must show exactly that text, spelled correctly, in big clean bold font.',
    '',
    'Reply with ONLY valid JSON: {"title":"","description":"","alt_text":"","overlay_text":"","image_prompt":""}'
  ].join('\n');

  const content = [{ type: 'text', text: prompt }];
  const withImage = product.image_url
    ? [{ type: 'image', source: { type: 'url', url: product.image_url } }].concat(content)
    : content;

  async function call(c) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env('ANTHROPIC_API_KEY', ''),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env('CLAUDE_MODEL', 'claude-haiku-5-5'),
        max_tokens: 1200,
        messages: [{ role: 'user', content: c }]
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude ' + r.status + ': ' + JSON.stringify(d.error || d).slice(0, 200));
    return (d.content || []).map((x) => x.text || '').join('');
  }

  let text;
  try {
    text = await call(withImage);
  } catch (e) {
    if (withImage === content) throw e;
    text = await call(content); // product image not reachable, try text only
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return JSON');
  const j = JSON.parse(m[0]);
  return {
    title: String(j.title || product.title).slice(0, 100),
    description: String(j.description || '').slice(0, 500),
    alt_text: String(j.alt_text || product.title).slice(0, 500),
    overlay_text: String(j.overlay_text || ''),
    image_prompt: String(j.image_prompt || ('Beautiful product photo of ' + product.title))
  };
}

async function makeImage(prompt, refUrl) {
  const key = env('OPENAI_API_KEY', '');
  const model = env('OPENAI_IMAGE_MODEL', 'gpt-image-1-mini');
  const quality = env('OPENAI_IMAGE_QUALITY', 'medium');
  let lastErr = '';

  if (refUrl) {
    try {
      const ir = await fetch(refUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (ir.ok && /^image\/(png|jpeg|jpg|webp)$/.test(ct)) {
        const buf = Buffer.from(await ir.arrayBuffer());
        const fd = new FormData();
        fd.append('model', model);
        fd.append('prompt', 'Use the product in the reference photo exactly as it is (same design, colors, shape, details). Create this pin image: ' + prompt);
        fd.append('size', '1024x1536');
        fd.append('quality', quality);
        fd.append('output_format', 'jpeg');
        fd.append('n', '1');
        fd.append('image', new Blob([buf], { type: ct }), 'product.' + (ct.split('/')[1] || 'jpg'));
        const r = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key },
          body: fd
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.data && d.data[0] && d.data[0].b64_json) return Buffer.from(d.data[0].b64_json, 'base64');
        lastErr = JSON.stringify(d.error || d).slice(0, 200);
      }
    } catch (e) {
      lastErr = e.message;
    }
  }

  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size: '1024x1536', quality, output_format: 'jpeg', n: 1 })
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.data && d.data[0] && d.data[0].b64_json) return Buffer.from(d.data[0].b64_json, 'base64');
  throw new Error('Image failed: ' + JSON.stringify(d.error || d).slice(0, 200) + (lastErr ? ' | edit: ' + lastErr : ''));
}

// ---------- daily maintenance ----------
async function fetchViews(account, fromDate, toDate) {
  const start = fromDate < addDays(toDate, -89) ? addDays(toDate, -89) : fromDate;
  const d = await pinApi(account,
    '/v5/user_account/analytics?start_date=' + start + '&end_date=' + toDate + '&metric_types=IMPRESSION');
  const all = d.all || d;
  if (all.summary_metrics && typeof all.summary_metrics.IMPRESSION === 'number') {
    return all.summary_metrics.IMPRESSION;
  }
  return (all.daily_metrics || []).reduce((s, x) => s + ((x.metrics && x.metrics.IMPRESSION) || 0), 0);
}

async function hasCharge(userId, kind, forCycle, statuses) {
  const rows = await dbGet('charges', 'user_id=eq.' + userId + '&kind=eq.' + kind +
    (forCycle ? '&for_cycle_start=eq.' + forCycle : '') +
    '&status=in.(' + statuses.join(',') + ')&select=id&limit=1');
  return rows.length > 0;
}

async function dailyMaintenance(acc, today, log) {
  const id = acc.id;

  // 1. Roll the cycle when it ends (only if next cycle's base charge is paid)
  if (acc.cycle_end && today >= acc.cycle_end) {
    const paid = await hasCharge(id, 'base', acc.cycle_end, ['captured']);
    if (paid) {
      const patch = {
        cycle_start: acc.cycle_end,
        cycle_end: addDays(acc.cycle_end, 30),
        cycle_views: 0,
        milestone_charged: 0,
        billing_status: 'active',
        posting_paused: false
      };
      await dbUpdate('accounts', 'id=eq.' + id, patch);
      Object.assign(acc, patch);
      log.push(id + ': new cycle');
    } else if (acc.billing_status !== 'past_due') {
      await dbUpdate('accounts', 'id=eq.' + id, { billing_status: 'past_due', posting_paused: true });
      acc.billing_status = 'past_due';
      acc.posting_paused = true;
      log.push(id + ': past due');
    }
  }

  // 2. Views for this cycle
  if (acc.pin_access_token && acc.cycle_start) {
    try {
      const views = await fetchViews(acc, acc.cycle_start, today);
      await dbUpdate('accounts', 'id=eq.' + id, { cycle_views: views });
      acc.cycle_views = views;
    } catch (e) {
      log.push(id + ': views error ' + e.message);
    }
  }

  // 3. Milestone debit, the same day the milestone is crossed
  const tier = milestoneFor(acc.cycle_views || 0);
  const charged = acc.milestone_charged || 0;
  if (acc.billing_status === 'active' && acc.rzp_token_id && tier > charged) {
    const open = await hasCharge(id, 'milestone', acc.cycle_start, ['created', 'pending']);
    if (!open) {
      try {
        await chargeMandate(acc, 'milestone', tier - charged, acc.cycle_start,
          'milestone ' + tier + ' at ' + acc.cycle_views + ' views');
        const patch = { milestone_charged: tier };
        if (PAUSE_ON_PENDING) patch.posting_paused = true;
        await dbUpdate('accounts', 'id=eq.' + id, patch);
        Object.assign(acc, patch);
        log.push(id + ': milestone Rs ' + (tier - charged));
      } catch (e) {
        log.push(id + ': milestone charge error ' + e.message);
      }
    }
  }

  // 4. Renewal: debit next cycle's base 2 days before the cycle ends
  //    (pre-debit notice needs 24h, a last-day debit fails)
  if (acc.rzp_token_id && acc.cycle_end && acc.billing_status !== 'locked' &&
      daysBetween(today, acc.cycle_end) <= 2) {
    const exists = await hasCharge(id, 'base', acc.cycle_end, ['created', 'pending', 'captured']);
    if (!exists) {
      try {
        await chargeMandate(acc, 'base', BASE_PRICE, acc.cycle_end, 'renewal');
        log.push(id + ': renewal charged');
      } catch (e) {
        log.push(id + ': renewal error ' + e.message);
      }
    }
  }

  // 5. Queue today's pins
  const boards = acc.board_ids || [];
  const canPost = acc.billing_status === 'active' && !acc.posting_paused && acc.pin_access_token && boards.length;
  if (canPost) {
    const prods = await dbGet('products', 'user_id=eq.' + id + '&select=id&limit=1');
    if (prods.length) {
      const n = Math.max(1, Math.min(10, acc.pins_per_day || 5));
      const dayStartUtc = new Date(today + 'T09:00:00+05:30').getTime(); // 9 AM IST
      const windowMs = 12 * 3600000;                                       // till 9 PM IST
      const now = Date.now();
      const rows = [];
      for (let i = 0; i < n; i++) {
        const slotLen = windowMs / n;
        let t = dayStartUtc + i * slotLen + Math.floor(Math.random() * slotLen * 0.6);
        if (t < now) t = now + i * 20 * 60000;
        rows.push({ user_id: id, run_date: today, slot: i, run_at: new Date(t).toISOString() });
      }
      await db('pin_jobs?on_conflict=user_id,run_date,slot', {
        method: 'POST',
        body: rows,
        prefer: 'resolution=ignore-duplicates,return=minimal'
      });
      log.push(id + ': queued ' + n);
    }
  }
}

// ---------- make + post one pin ----------
async function runJob(job, today) {
  const acc = (await dbGet('accounts', 'id=eq.' + job.user_id + '&select=*'))[0];
  const boards = (acc && acc.board_ids) || [];
  if (!acc || acc.billing_status !== 'active' || acc.posting_paused || !acc.pin_access_token || !boards.length) {
    await dbUpdate('pin_jobs', 'id=eq.' + job.id, { status: 'skipped', error: 'account not active or paused' });
    return 'skipped';
  }

  const prod = (await dbGet('products', 'user_id=eq.' + acc.id +
    '&select=*&order=last_used_at.asc.nullsfirst,id.asc&limit=1'))[0];
  if (!prod) {
    await dbUpdate('pin_jobs', 'id=eq.' + job.id, { status: 'skipped', error: 'no products' });
    return 'skipped';
  }
  // Mark product used right away so parallel jobs pick a different one
  await dbUpdate('products', 'id=eq.' + prod.id, {
    last_used_at: new Date().toISOString(),
    use_count: (prod.use_count || 0) + 1
  });

  const dayNum = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 86400000);
  const style = STYLES[(job.slot + dayNum) % STYLES.length];
  const boardId = boards[(job.slot + dayNum) % boards.length];

  try {
    const text = await writePinText(acc, prod, style, today);
    const img = await makeImage(text.image_prompt, prod.image_url);
    const path = acc.id + '/' + today + '-' + job.slot + '-' + job.id + '.jpg';
    const imageUrl = await uploadImage(path, img, 'image/jpeg');

    const pin = await pinApi(acc, '/v5/pins', {
      method: 'POST',
      body: {
        board_id: boardId,
        title: text.title,
        description: text.description,
        alt_text: text.alt_text,
        link: prod.link,
        media_source: { source_type: 'image_url', url: imageUrl }
      }
    });

    await dbUpdate('pin_jobs', 'id=eq.' + job.id, {
      status: 'posted',
      product_id: prod.id,
      board_id: boardId,
      style: style,
      title: text.title,
      description: text.description,
      alt_text: text.alt_text,
      image_url: imageUrl,
      pinterest_pin_id: pin.id || null,
      error: null
    });
    return 'posted';
  } catch (e) {
    await dbUpdate('pin_jobs', 'id=eq.' + job.id, {
      status: 'failed',
      product_id: prod.id,
      style: style,
      error: String(e.message).slice(0, 500)
    });
    return 'failed';
  }
}

module.exports = async (req, res) => {
  const key = req.headers['x-cron-secret'] || (req.query && req.query.key);
  if (!key || key !== env('CRON_SECRET', '')) return send(res, 401, { error: 'unauthorized' });

  const started = Date.now();
  const budget = parseInt(env('WORKER_BUDGET_MS', '240000'), 10);
  const left = () => budget - (Date.now() - started);
  const today = todayIST();
  const log = [];
  const result = { maintained: 0, posted: 0, failed: 0, skipped: 0 };

  try {
    // Jobs stuck in "running" for 2h+ (crashed run) -> failed
    await dbUpdate('pin_jobs', 'status=eq.running&run_at=lt.' +
      new Date(Date.now() - 2 * 3600000).toISOString(), { status: 'failed', error: 'timed out' });

    // 1. Daily maintenance
    const due = await dbGet('accounts',
      'billing_status=in.(active,past_due)&or=(last_daily_run.is.null,last_daily_run.lt.' + today + ')' +
      '&select=*&limit=25');
    for (const acc of due) {
      if (left() < budget * 0.5) break;
      try {
        await dailyMaintenance(acc, today, log);
      } catch (e) {
        log.push(acc.id + ': maintenance error ' + e.message);
      }
      await dbUpdate('accounts', 'id=eq.' + acc.id, { last_daily_run: today });
      result.maintained++;
    }

    // 2. Make and post due pins
    while (left() > 80000) {
      const next = (await dbGet('pin_jobs', 'status=eq.queued&run_at=lte.' + new Date().toISOString() +
        '&select=*&order=run_at.asc&limit=1'))[0];
      if (!next) break;
      const claimed = await dbUpdate('pin_jobs', 'id=eq.' + next.id + '&status=eq.queued', { status: 'running' });
      if (!claimed || !claimed.length) continue;
      const r = await runJob(next, today);
      result[r] = (result[r] || 0) + 1;
    }

    send(res, 200, { ok: true, today, result, log, ms: Date.now() - started });
  } catch (e) {
    send(res, 500, { error: e.message, result, log });
  }
};
