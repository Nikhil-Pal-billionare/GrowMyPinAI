// Pinterest redirects here after the user approves access.
const { unsign, pinTokenRequest, dbUpdate, APP_URL, PIN_API } = require('./_lib');

function back(res, msg) {
  res.statusCode = 302;
  res.setHeader('Location', APP_URL + '/app.html?pinterest=' + encodeURIComponent(msg));
  res.end();
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.error) return back(res, 'denied');
    const value = unsign(q.state);
    if (!value) return back(res, 'bad_state');
    const parts = value.split(':');
    const userId = parts[0];
    const ts = parseInt(parts[1] || '0', 10);
    if (!userId || Date.now() - ts > 30 * 60000) return back(res, 'expired');

    const t = await pinTokenRequest({
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: APP_URL + '/api/pinterest-callback'
    });

    let username = null;
    try {
      const r = await fetch(PIN_API + '/v5/user_account', {
        headers: { Authorization: 'Bearer ' + t.access_token }
      });
      const u = await r.json();
      username = u.username || null;
    } catch (e) { /* not critical */ }

    await dbUpdate('accounts', 'id=eq.' + userId, {
      pin_access_token: t.access_token,
      pin_refresh_token: t.refresh_token || null,
      pin_token_expires_at: new Date(Date.now() + (t.expires_in || 2592000) * 1000).toISOString(),
      pin_username: username
    });
    back(res, 'connected');
  } catch (e) {
    back(res, 'error');
  }
};
