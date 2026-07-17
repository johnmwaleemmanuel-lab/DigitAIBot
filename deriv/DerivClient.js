  connect() {
    this.intentionalDisconnect = false;

    const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.cfg.deriv.appId}`;

    // DEBUG
    console.log("Connecting to:", url);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.log('WebSocket connected, authorizing...');
      this._send({ authorize: this.cfg.deriv.apiToken });
    });

    this.ws.on('message', (raw) => this._handleMessage(raw));

    this.ws.on('close', () => {
      this.authorized = false;
      this.emit('disconnected');
      if (this.intentionalDisconnect) {
        this.log('Disconnected (logout) — will not auto-reconnect.');
        return;
      }
      this.log('Disconnected from Deriv. Reconnecting immediately...', 'warn');
      this._reconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
      this.log(`WebSocket error: ${err.message}`, 'error');
    });
  }