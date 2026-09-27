// Firebase bootstrap shared by the host and player pages.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  initializeAuth, signInAnonymously, connectAuthEmulator,
  browserSessionPersistence, browserLocalPersistence, indexedDBLocalPersistence,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase, connectDatabaseEmulator, ref, onValue,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

export {
  ref, get, set, update, remove, onValue, onDisconnect, runTransaction,
  serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

// Local testing against the Firebase Emulator Suite (see README). Only
// possible on localhost, switched on by adding ?emulator=1 to the URL.
const EMULATOR_CONFIG = {
  apiKey: "demo-key",
  authDomain: "demo-kahoot.firebaseapp.com",
  databaseURL: "https://demo-kahoot-default-rtdb.firebaseio.com",
  projectId: "demo-kahoot",
};

export function isEmulator() {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!local) return false;
  const params = new URLSearchParams(location.search);
  try {
    if (params.has("emulator")) sessionStorage.setItem("kq_emulator", "1");
    return sessionStorage.getItem("kq_emulator") === "1";
  } catch {
    return params.has("emulator");
  }
}

export class ConfigError extends Error {}

/**
 * Initialise Firebase and sign in anonymously.
 * role "host"   → auth survives browser restarts (so the teacher can resume a game).
 * role "player" → auth lives in sessionStorage, so every tab/phone is its own player
 *                 and a refresh keeps the same player ID (and score).
 */
export async function initFirebase(role) {
  const emulator = isEmulator();
  if (!emulator && String(firebaseConfig.apiKey).startsWith("YOUR_")) {
    throw new ConfigError("Firebase is not configured yet. Fill in js/firebase-config.js (see README).");
  }
  const app = initializeApp(emulator ? EMULATOR_CONFIG : firebaseConfig, role);
  const auth = initializeAuth(app, {
    persistence: role === "host"
      ? [indexedDBLocalPersistence, browserLocalPersistence]
      : browserSessionPersistence,
  });
  const db = getDatabase(app);
  if (emulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
  }

  let offset = 0;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });

  await auth.authStateReady();
  if (!auth.currentUser) {
    try {
      await signInAnonymously(auth);
    } catch (e) {
      if (["auth/admin-restricted-operation", "auth/operation-not-allowed"].includes(e.code)) {
        throw new ConfigError("Anonymous sign-in is turned off. In the Firebase console go to Security → Authentication → Sign-in method → Anonymous → Enable → Save, then reload this page.");
      }
      throw e;
    }
  }

  return {
    db,
    uid: auth.currentUser.uid,
    emulator,
    /** Current time on the Firebase server, in ms. Used for all countdowns. */
    serverNow: () => Date.now() + offset,
    onConnection(cb) { return onValue(ref(db, ".info/connected"), (s) => cb(s.val() === true)); },
  };
}
