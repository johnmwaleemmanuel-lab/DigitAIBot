'use strict';

const fs = require('fs');
const path = require('path');

/**
 * SessionStore
 * Persists the logged-in Deriv OAuth session (account id, token, account
 * type) to a local file so the user stays logged in across server restarts
 * until they explicitly log out. This is a single-user local bot, so a
 * local file is the storage model — not a multi-user cookie/session system.
 */
class SessionStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '..', 'data', 'session.json');
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  save(session) {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(session, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  }

  clear() {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = SessionStore;
