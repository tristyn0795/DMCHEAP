// Thin WebSocket client with auto-reconnect. Same origin as the page, so on Railway
// this becomes wss://<service>.up.railway.app/ws through the public HTTPS proxy.
export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.retry = 0;
    this.hello = null;
    this.bytesIn = 0;
  }
  on(type, fn) { this.handlers.set(type, fn); }
  connect(hello) {
    this.hello = hello;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.send(this.hello()); this.handlers.get('_open')?.(); };
    ws.onmessage = (ev) => {
      this.bytesIn += ev.data.length;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const h = this.handlers.get(m.t);
      if (h) h(m); else this.handlers.get('_any')?.(m);
    };
    ws.onclose = (ev) => {
      this.handlers.get('_close')?.(ev);
      if (ev.code === 4001) return; // replaced by another tab
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(this.hello), delay);
    };
  }
  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}
