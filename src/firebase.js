import { initializeApp } from "firebase/app";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
} from "firebase/firestore";

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
//
// localCache(영속 캐시): 기본값은 메모리 전용이라 페이지를 열 때마다 캐시가 비어 있다.
//   그 상태에서 백엔드에 닿지 못하면 문서 리스너가 "문서 없음" 스냅샷을 발행하고,
//   그걸 신호로 초기 데이터를 쓰면 운영 DB가 통째로 날아간다(2026-09-07 사고).
//   IndexedDB 캐시를 쓰면 오프라인으로 열어도 직전 문서가 그대로 살아 있다.
// experimentalAutoDetectLongPolling: 사내망/VPN 프록시가 WebChannel 스트리밍을 끊는 환경에서
//   자동으로 롱폴링으로 우회한다.
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    experimentalAutoDetectLongPolling: true,
});

export const DATA_DOC_PATH = ["dashboard", "data"];
export const CONFIG_DOC_PATH = ["dashboard", "config"];
