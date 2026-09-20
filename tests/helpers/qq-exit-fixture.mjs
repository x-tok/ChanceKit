import { WebSocketServer } from 'ws';
import { createInterface } from 'node:readline';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('listening', () => process.send?.({ port: server.address().port }));
process.on('SIGTERM', () => {
  process.send?.({ event: 'sigterm' }, () => process.exit(73));
});
if (process.argv[2] === 'prelogin') createInterface({ input: process.stdin }).on('line', command => {
  if (command === 'chancekit:quit') process.send?.({ event: 'control_exit' }, () => process.exit(0));
});
server.on('connection', (socket, request) => {
  if (process.argv[2] === 'prelogin') return socket.close(1013);
  if (request.headers.authorization !== 'Bearer fixture-exit-token') return socket.close(1008);
  socket.on('message', bytes => {
    const { action } = JSON.parse(bytes.toString());
    process.send?.({ event: action });
    if (action !== 'bot_exit' || process.argv[2] === 'unresponsive') return;
    // NapCat exits without returning an action response. Transport closure is not an exit acknowledgement.
    socket.close();
    setTimeout(() => process.exit(0), process.argv[2] === 'delayed' ? 200 : 20);
  });
});
