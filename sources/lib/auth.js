/**
 * Identity checks for the WebSocket server.
 *
 * The server used to take a client's word for who it was: `if (msgData.token && keys.length > 0)`
 * only checked that a token was *present*. Any client could claim someone else's login and receive
 * their messages, or publish into the broker without authenticating at all.
 *
 * The token is stored by the API in Redis as `nyx_tok_<token>` -> the `nyx_user` document, with a
 * 24 h TTL; that store is the authority, and the claimed identity must match the account the token
 * belongs to — otherwise a valid token of one's own would be enough to impersonate anyone.
 *
 * Kept free of I/O so the rules can be tested without a Redis instance.
 */

var TOKEN_KEY_PREFIX = "nyx_tok_";

function loginKeys(user) {
  if (!user || typeof user !== "object") {
    return [];
  }
  var keys = [];
  ["id", "user", "login"].forEach(function (field) {
    var value = user[field];
    if (value && typeof value === "string") {
      // A blank identifier must not register a login: it would land in the map under a key nobody
      // else can address, and the socket would look authenticated.
      var trimmed = value.trim();
      if (trimmed && keys.indexOf(trimmed) === -1) {
        keys.push(trimmed);
      }
    }
  });
  return keys;
}

function tokenKey(token) {
  return TOKEN_KEY_PREFIX + String(token || "");
}

/**
 * True when the account stored for this token is the account being claimed.
 * `storedAccount` is the raw value read from Redis (the `nyx_user` document as JSON), or null.
 */
function identityMatches(storedAccount, claimedKeys) {
  if (!storedAccount || !claimedKeys || claimedKeys.length === 0) {
    return false;
  }
  var account;
  try {
    account = typeof storedAccount === "string" ? JSON.parse(storedAccount) : storedAccount;
  } catch (e) {
    return false;
  }
  if (!account || typeof account !== "object") {
    return false;
  }
  var owned = [account.id, account._id, account.login, account.user]
    .filter(function (value) {
      return value && typeof value === "string";
    })
    .map(function (value) {
      return value.toLowerCase();
    });
  return claimedKeys.some(function (key) {
    return owned.indexOf(String(key).toLowerCase()) !== -1;
  });
}

/** Masks token-like values so a log line never carries a replayable session. */
function redact(text) {
  var value = String(text == null ? "" : text);
  value = value.replace(/("?(?:token|password|passwd|secret)"?\s*[:=]\s*")[^"]*"/gi, "$1***\"");
  value = value.replace(/(Bearer\s+)[\w.\-]+/gi, "$1***");
  return value;
}

module.exports = {
  TOKEN_KEY_PREFIX: TOKEN_KEY_PREFIX,
  loginKeys: loginKeys,
  tokenKey: tokenKey,
  identityMatches: identityMatches,
  redact: redact
};
