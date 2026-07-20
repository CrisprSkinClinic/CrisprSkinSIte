import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBO1Uq6OFz8piouLlPvKRHHRmmpKZAGH74",
  authDomain: "crispr-eye-care.firebaseapp.com",
  projectId: "crispr-eye-care",
  storageBucket: "crispr-eye-care.firebasestorage.app",
  messagingSenderId: "672088910476",
  appId: "1:672088910476:web:d0cb1e85281a4afa3769a9"
};

// Initialize Firebase, Firestore, and Auth
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

/**
 * Ensures the visitor has an anonymous Firebase Auth session before
 * they're allowed to write booking data. Resolves with the user's uid.
 * Safe to call multiple times — Firebase will reuse the existing session
 * if one already exists in this browser.
 */
export function ensureAnonymousAuth() {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user.uid);
        } else {
          signInAnonymously(auth)
            .then((result) => {
              unsubscribe();
              resolve(result.user.uid);
            })
            .catch((error) => {
              unsubscribe();
              reject(error);
            });
        }
      },
      (error) => {
        unsubscribe();
        reject(error);
      }
    );
  });
}
