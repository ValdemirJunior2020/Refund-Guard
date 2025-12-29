import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyC7Y-LT6hBF9uhv2Fj-J74KencZqvOiwJg",
  authDomain: "psych-support-app.firebaseapp.com",
  projectId: "psych-support-app",
  storageBucket: "psych-support-app.firebasestorage.app",
  messagingSenderId: "1090749452629",
  appId: "1:1090749452629:web:073d01319785225c0cdfdc",
  measurementId: "G-NX0KK99XFC",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Firestore (this is what we actually use)
export const db = getFirestore(app);

// Analytics (safe for localhost)
export async function initAnalytics(): Promise<void> {
  try {
    const supported = await isSupported();
    if (supported) {
      getAnalytics(app);
    }
  } catch {
    // ignore analytics errors
  }
}
