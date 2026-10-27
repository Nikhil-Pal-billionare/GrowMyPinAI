// GET  /api/boards                 -> list the user's Pinterest boards
// POST /api/boards {name}          -> create a new board
const { send, readJson, requireAccount, pinApi } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    if (!account.pin_access_token) return send(res, 400, { error: 'Connect Pinterest first' });

    if (req.method === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').trim().slice(0, 50);
      if (!name) return send(res, 400, { error: 'Board name required' });
      const board = await pinApi(account, '/v5/boards', {
        method: 'POST',
        body: { name: name, privacy: 'PUBLIC' }
      });
      return send(res, 200, { ok: true, board: { id: board.id, name: board.name } });
    }

    const data = await pinApi(account, '/v5/boards?page_size=100');
    const boards = (data.items || []).map((x) => ({ id: x.id, name: x.name, pin_count: x.pin_count }));
    send(res, 200, { boards });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
