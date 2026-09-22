import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash } from 'node:crypto';

const sampleBaseTime = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

export const sample = (id: number, text: string, groupId = 731234567) => ({
  time: sampleBaseTime + id * 60, message_type: 'group', post_type: 'message', self_id: 100010001,
  group_id: groupId, message_id: id, message_seq: id, real_seq: String(id + 9000),
  sender: { user_id: 200020002, nickname: '校招信息员（测试）', card: '' },
  message: [{ type: 'text', data: { text } }], raw_message: text,
});
export async function mockNapCat() {
  const calls: { action: string; params: any }[] = [];
  const responses = new Map<string, (params: any) => unknown>();
  let loggedIn = true;
  let account = { user_id: 100010001, nickname: '见机测试账号' };
  const held = new Map<string, (reply: () => void) => void>();
  let qrRefreshed = 0;
  let completeHistoryAtBoundary = false;
  const server = createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data || '{}');
    res.setHeader('Content-Type', 'application/json');
    const send = (data: unknown) => res.end(JSON.stringify({ code: 0, data, message: 'success' }));
    if (req.url === '/api/auth/login') {
      if (body.hash !== createHash('sha256').update('test-management.napcat').digest('hex')) return res.end(JSON.stringify({ code: -1, message: 'token is invalid' }));
      return send({ Credential: 'fixture-credential' });
    }
    if (req.headers.authorization !== 'Bearer fixture-credential') return res.end(JSON.stringify({ code: -1, message: 'Authorization Failed' }));
    if (req.url === '/api/QQLogin/CheckLoginStatus') return send({ isLogin: loggedIn, isOffline: false, qrcodeurl: `https://example.com/test-qq-login?revision=${qrRefreshed}`, loginError: '' });
    if (req.url === '/api/QQLogin/RefreshQRcode') { qrRefreshed++; return send(null); }
    res.statusCode = 404; res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    if (req.headers.authorization !== 'Bearer test-onebot') { socket.close(1008); return; }
    socket.on('message', bytes => {
      const { action, params, echo } = JSON.parse(bytes.toString());
      calls.push({ action, params });
      const ok = (data: unknown) => {
        const reply = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo })); };
        const hold = held.get(action);
        if (hold) { held.delete(action); hold(reply); } else reply();
      };
      if (responses.has(action)) return ok(responses.get(action)!(params));
      if (action === 'get_login_info') return ok(account);
      if (action === 'get_group_list') return ok([
        { group_id: 731234567, group_name: '2027 届校园招聘信息交流（测试）', member_count: 387, max_member_count: 500 },
        { group_id: 731234568, group_name: '宣讲会与双选会通知（测试）', member_count: 216, max_member_count: 500 },
        { group_id: 731234569, group_name: '实习机会 · 计算机与电子信息（测试）', member_count: 143, max_member_count: 200 },
      ]);
      if (action === 'get_group_msg_history') {
        if (params.group_id === '731234569') return socket.send(JSON.stringify({ status: 'failed', retcode: 1200, wording: '消息undefined不存在', echo }));
        if (params.message_seq === '1') {
          if (completeHistoryAtBoundary) return ok({ messages: [{ ...sample(0, '三天前的范围外消息'), time: Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60 }] });
          return socket.send(JSON.stringify({ status: 'failed', retcode: 1200, wording: '消息1不存在', echo }));
        }
        if (params.message_seq && !params.reverse_order) return ok({ messages: [sample(Number(params.message_seq), '锚点本身'), sample(Number(params.message_seq) + 1, '较新的消息')] });
        return ok({ messages: params.message_seq ? [sample(1, '较早的双选会通知。'), sample(2, '请关注学校就业中心的后续通知。')] : [
          sample(3, '【校园宣讲会】\n时间：9 月 24 日 14:30\n地点：大学生活动中心 201 室\n请带上简历，现场安排交流与答疑。'),
          sample(4, '招聘详情与报名入口：\nhttps://example.com/campus-recruiting'),
          sample(5, '收到，感谢分享。'),
        ] });
      }
      if (action === 'get_forward_msg') return ok({ messages: [{ sender: { nickname: '就业中心（测试）' }, content: [{ type: 'text', data: { text: '转发招聘通知' } }] }] });
      if (action === 'get_group_file_url') return ok({ url: 'https://example.com/notice.docx' });
      if (action === 'get_image') return ok({ url: 'https://example.com/refreshed.png' });
      if (action === 'delayed') return setTimeout(() => ok(params), Number(params.delay));
      if (action === 'never') return;
      return socket.send(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'Unknown action', echo }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    config: { wsUrl: `ws://127.0.0.1:${port}`, accessToken: 'test-onebot', webuiUrl: `http://127.0.0.1:${port}`, webuiToken: 'test-management' }, calls,
    respond: (action: string, response: (params: any) => unknown) => { responses.set(action, response); },
    completeHistoryAtBoundary: () => { completeHistoryAtBoundary = true; },
    setLoggedIn: (value: boolean) => { loggedIn = value; },
    setAccount: (value: typeof account) => { account = value; },
    holdNext: (action: string) => {
      let release = () => {};
      const requested = new Promise<void>(resolve => held.set(action, reply => { release = reply; resolve(); }));
      return { requested, release: () => release() };
    },
    push: (event: unknown) => { for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); },
    drop: () => { for (const client of wss.clients) client.terminate(); },
    close: async () => { for (const client of wss.clients) client.terminate(); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); },
  };
}
