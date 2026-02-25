import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyCrcfv5AKFmNneeMrNuQpWq79YsEXQJk54",
    authDomain: "aidash-d831b.firebaseapp.com",
    projectId: "aidash-d831b",
    storageBucket: "aidash-d831b.firebasestorage.app",
    messagingSenderId: "718233578258",
    appId: "1:718233578258:web:43fe9cdf7305747e4021cb",
    measurementId: "G-B457G5G30D"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Cloud Firestore and get a reference to the service
export const db = getFirestore(app);
