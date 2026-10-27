// GET    /api/products                 -> list products
// POST   /api/products {action:"add", title, link, image_url, description, price}
// POST   /api/products {action:"import"}  -> import from Shopify store or Etsy shop
// DELETE /api/products?id=123
const { env, send, readJson, requireAccount, dbGet, dbInsert, dbDelete } = require('./_lib');

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function shopifyDomain(url) {
  let u = String(url || '').trim().toLowerCase();
  u = u.replace(/^https?:\/\//, '').split('/')[0];
  return u;
}

function etsyShopName(url) {
  const s = String(url || '').trim();
  let m = s.match(/etsy\.com\/(?:[a-z-]+\/)?shop\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  m = s.match(/^(?:https?:\/\/)?([A-Za-z0-9]+)\.etsy\.com/i);
  if (m && m[1].toLowerCase() !== 'www') return m[1];
  if (/^[A-Za-z0-9]+$/.test(s)) return s;
  return null;
}

async function importShopify(storeUrl) {
  const domain = shopifyDomain(storeUrl);
  if (!domain) throw new Error('Add your Shopify store URL in Settings first');
  const r = await fetch('https://' + domain + '/products.json?limit=250', {
    headers: { 'User-Agent': 'Mozilla/5.0 GrowMyPinAutopilot' }
  });
  if (!r.ok) throw new Error('Could not read products from ' + domain + ' (status ' + r.status + '). Add products manually.');
  const data = await r.json();
  return (data.products || []).map((p) => ({
    title: String(p.title || '').slice(0, 200),
    link: 'https://' + domain + '/products/' + p.handle,
    image_url: p.images && p.images[0] ? p.images[0].src : null,
    description: stripHtml(p.body_html).slice(0, 1000),
    price: p.variants && p.variants[0] ? String(p.variants[0].price) : null
  }));
}

async function importEtsy(storeUrl) {
  const key = env('ETSY_API_KEY', '');
  if (!key) throw new Error('Etsy auto-import is not enabled yet. Add products manually.');
  const shop = etsyShopName(storeUrl);
  if (!shop) throw new Error('Add your Etsy shop link in Settings first (example: etsy.com/shop/YourShop)');
  const h = { 'x-api-key': key };
  const s = await fetch('https://openapi.etsy.com/v3/application/shops?shop_name=' + encodeURIComponent(shop), { headers: h });
  const sd = await s.json().catch(() => ({}));
  const found = (sd.results || []).find((x) => String(x.shop_name).toLowerCase() === shop.toLowerCase()) || (sd.results || [])[0];
  if (!found) throw new Error('Etsy shop not found: ' + shop);
  const l = await fetch('https://openapi.etsy.com/v3/application/shops/' + found.shop_id +
    '/listings/active?limit=100&includes=Images', { headers: h });
  const ld = await l.json().catch(() => ({}));
  if (!l.ok) throw new Error('Etsy listings error: ' + JSON.stringify(ld).slice(0, 200));
  return (ld.results || []).map((p) => {
    const img = p.images && p.images[0] ? (p.images[0].url_fullxfull || p.images[0].url_570xN) : null;
    const price = p.price ? (p.price.amount / p.price.divisor) + ' ' + p.price.currency_code : null;
    return {
      title: String(p.title || '').slice(0, 200),
      link: String(p.url || ('https://www.etsy.com/listing/' + p.listing_id)).split('?')[0],
      image_url: img,
      description: stripHtml(p.description).slice(0, 1000),
      price: price
    };
  });
}

module.exports = async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const uid = account.id;

    if (req.method === 'GET') {
      const rows = await dbGet('products', 'user_id=eq.' + uid + '&select=*&order=created_at.desc&limit=500');
      return send(res, 200, { products: rows });
    }

    if (req.method === 'DELETE') {
      const id = parseInt((req.query && req.query.id) || '0', 10);
      if (!id) return send(res, 400, { error: 'Missing id' });
      await dbDelete('products', 'id=eq.' + id + '&user_id=eq.' + uid);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);

      if (b.action === 'add') {
        const title = String(b.title || '').trim();
        const link = String(b.link || '').trim();
        if (!title || !/^https?:\/\//i.test(link)) return send(res, 400, { error: 'Title and a full product link (https://...) are required' });
        const rows = await dbInsert('products', {
          user_id: uid,
          title: title.slice(0, 200),
          link: link.slice(0, 500),
          image_url: /^https?:\/\//i.test(b.image_url || '') ? String(b.image_url).slice(0, 800) : null,
          description: String(b.description || '').slice(0, 1000),
          price: String(b.price || '').slice(0, 40) || null
        });
        return send(res, 200, { ok: true, product: rows[0] });
      }

      if (b.action === 'import') {
        const items = account.platform === 'etsy'
          ? await importEtsy(account.store_url)
          : await importShopify(account.store_url);
        const existing = await dbGet('products', 'user_id=eq.' + uid + '&select=link&limit=2000');
        const have = new Set(existing.map((p) => p.link));
        const fresh = items.filter((p) => p.title && p.link && !have.has(p.link))
          .map((p) => Object.assign({ user_id: uid }, p));
        if (fresh.length) await dbInsert('products', fresh);
        return send(res, 200, { ok: true, imported: fresh.length, found: items.length });
      }

      return send(res, 400, { error: 'Unknown action' });
    }

    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
