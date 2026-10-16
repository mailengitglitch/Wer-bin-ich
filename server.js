const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const app = express(); app.use(express.static('public'));
const srv = http.createServer(app), wss = new WebSocketServer({ noServer: true });
require('./werbinich.js')(wss);
srv.on('upgrade', (req, sock, head) => {
  if (req.url.split('?')[0] !== '/ws2') return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});
srv.listen(process.env.PORT || 3000, () => console.log('Läuft auf Port ' + (process.env.PORT || 3000)));
