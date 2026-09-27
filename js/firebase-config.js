// ─────────────────────────────────────────────────────────────
//  Firebase + game settings. This is the only file you need to edit.
//  See README.md → "Firebase setup" for where to find these values.
// ─────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "AIzaSyAUUFYzfEnR8-dl-IBAmyF1mBf3hDaLkzk",
  authDomain: "classroom-quiz-f49e3.firebaseapp.com",
  databaseURL: "https://classroom-quiz-f49e3-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "classroom-quiz-f49e3",
  storageBucket: "classroom-quiz-f49e3.firebasestorage.app",
  messagingSenderId: "96880460521",
  appId: "1:96880460521:web:85ed031da67fd34e752678",
};

// PIN the teacher types to open host.html. This is a simple gate, not real
// security: anyone who reads this file can see it. Change it before class.
export const HOST_PIN = "2468";

export const GAME = {
  maxPlayers: 50,        // the 51st player sees "Game is full"
  questionSeconds: 120,  // countdown per question
  basePoints: 500,       // points for a correct answer
  speedBonus: 500,       // extra points for answering instantly (scales down to 0)
};
