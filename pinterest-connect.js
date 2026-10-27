// GET /api/pinterest-connect -> { url } to send the user to Pinterest login
const { env, send, requireAccount, sign, APP_URL } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const state = sign(account.id + ':' + Date.now());
    const params = new URLSearchParams({
      client_id: env('PINTEREST_APP_ID', ''),
      redirect_uri: APP_URL + '/api/pinterest-callback',
      response_type: 'code',
      scope: 'boards:read,boards:write,pins:read,pins:write,user_accounts:read',
      state: state
    });
    send(res, 200, { url: 'https://www.pinterest.com/oauth/?' + params.toString() });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
