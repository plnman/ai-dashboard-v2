import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { doc, setDoc, getDoc, onSnapshot, runTransaction } from "firebase/firestore";

/* ═══════════════════════════════════════════════════
   초기 데이터
═══════════════════════════════════════════════════ */
const uid = () => "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

// ⚠️ 초기 시드 데이터(INIT)는 의도적으로 제거되었습니다.
// 2026-09-07, 오프라인 상태로 앱을 연 브라우저가 "문서 없음" 스냅샷을 받고 이 배열을
// 운영 DB에 덮어써서 전체 데이터가 소실되었습니다. 클라이언트는 어떤 경우에도
// 대시보드 문서를 새로 만들지 않습니다. 최초 생성은 관리 콘솔에서만 수행하세요.

const DATA_DOC = ["dashboard", "data"];
const CONFIG_DOC = ["dashboard", "config"];

// 레거시 비밀번호. config 문서가 아직 없는 환경에서만 1회 통용되며,
// 관리자가 비밀번호를 변경하는 순간 무효가 됩니다.
const LEGACY_ADMIN_PWD = "admin1234";

const countParticipants = (cs) =>
  (cs || []).reduce((s, c) => s + (c.participants?.length || 0), 0);

// 비밀번호는 PBKDF2-SHA256 + 무작위 솔트로 유도한다.
// config 문서는 클라이언트가 읽어야 검증이 되므로 해시가 노출된다.
// 단순 SHA-256이면 레인보우 테이블로 즉시 역산되지만, 솔트와 반복 횟수가 있으면
// 쓸만한 비밀번호에 대해 대입 비용이 실질적으로 커진다.
const PBKDF2_ITERATIONS = 310000;

const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex) =>
  new Uint8Array((hex.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));

function requireCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("이 브라우저에서는 암호화 기능을 쓸 수 없습니다. https 주소로 접속해 주세요.");
  }
}

async function derivePassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  requireCrypto();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" }, key, 256
  );
  return toHex(bits);
}

function newSaltHex() {
  requireCrypto();
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

// 길이가 같은 문자열의 상수 시간 비교 (타이밍 차이로 정보가 새지 않도록)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// adminAuth: { hash, salt, iterations } 또는 null(아직 미설정)
async function verifyAdminPassword(password, adminAuth) {
  if (!adminAuth?.hash || !adminAuth?.salt) return password === LEGACY_ADMIN_PWD;
  const derived = await derivePassword(password, adminAuth.salt, adminAuth.iterations || PBKDF2_ITERATIONS);
  return safeEqual(derived, adminAuth.hash);
}

/* ─── 계정 백업(참여자 명단 전용) ─────────────────── */
const BACKUP_VERSION = 1;
const LOCAL_SNAPSHOT_KEY = "ai-dashboard-roster-snapshots";
const LOCAL_SNAPSHOT_MAX = 5;

// 과제/진척도/요약/채팅은 제외하고 계정 복구에 필요한 것만 담는다.
const buildRosterBackup = (companies) => ({
  version: BACKUP_VERSION,
  exportedAt: new Date().toISOString(),
  companies: (companies || []).map((c) => ({
    id: c.id,
    name: c.name,
    schedule: c.schedule || null,
    participants: (c.participants || []).map((p) => ({
      id: p.id, name: p.name, dept: p.dept || "", email: p.email || "",
    })),
  })),
});

const parseRosterBackup = (raw) => {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.companies)) {
    throw new Error("백업 파일 형식이 올바르지 않습니다. (companies 배열 없음)");
  }
  return data;
};

// 백업 ↔ 현재 데이터 비교. 실제 반영 전에 무엇이 추가되는지 보여주기 위한 것.
const diffRosterBackup = (backup, companies) => {
  const newCompanies = [];
  const newParticipants = [];
  let existing = 0;

  for (const bc of backup.companies) {
    const target = companies.find((c) => c.id === bc.id) || companies.find((c) => c.name === bc.name);
    if (!target) newCompanies.push(bc.name);
    for (const bp of bc.participants || []) {
      const dup = target?.participants?.some(
        (p) => p.id === bp.id || (p.name === bp.name && p.email === bp.email)
      );
      if (dup) existing++;
      else newParticipants.push({ company: bc.name, name: bp.name, dept: bp.dept, email: bp.email });
    }
  }
  return { newCompanies, newParticipants, existing };
};

const readLocalSnapshots = () => {
  try {
    const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
};

const writeLocalSnapshot = (companies) => {
  try {
    if (countParticipants(companies) === 0) return;
    const snap = buildRosterBackup(companies);
    const list = readLocalSnapshots();
    const last = list[0];
    // 명단이 그대로면 중복 저장하지 않는다.
    if (last && JSON.stringify(last.companies) === JSON.stringify(snap.companies)) return;
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify([snap, ...list].slice(0, LOCAL_SNAPSHOT_MAX)));
  } catch { /* 저장 실패는 무시 — 보조 수단일 뿐 */ }
};

/* ═══════════════════════════════════════════════════
   유틸
═══════════════════════════════════════════════════ */
const avgProgress = (p) =>
  p.tasks.length === 0 ? 0
    : Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length);

const pColor = (v) => v >= 70 ? "bg-emerald-400" : v >= 40 ? "bg-amber-400" : "bg-rose-400";

/* ─── 과제 부가 정보 ──────────────────────────────
   효과는 금액 / 시간 중 하나만 고른다. 둘 다 받으면 같은 절감을 두 번 세게 되어
   업체 합계가 부풀기 때문이다. 효과%는 분모가 과제마다 달라 합산도 평균도
   불가능해서 아예 넣지 않았다. */
const TASK_SCOPES = ["경영진", "관련부서", "부서원", "본인", "전사"];
const EFFECT_TYPES = ["금액", "시간"];
const EFFECT_UNIT = { 금액: "원", 시간: "시간" };

const emptyTaskMeta = () => ({ scope: "", headcount: "", effectType: "", effectValue: "" });

// 저장 직전 정규화. 숫자는 숫자로, 미입력은 빈 문자열/0 으로 통일한다.
const normalizeTaskMeta = (m) => ({
  scope: m.scope || "",
  headcount: Number(m.headcount) > 0 ? Number(m.headcount) : 0,
  effectType: m.effectType || "",
  effectValue: m.effectType && Number(m.effectValue) > 0 ? Number(m.effectValue) : 0,
});

const fmtNum = (n) => Number(n || 0).toLocaleString("ko-KR");

const effectLabel = (t) =>
  t?.effectType && t.effectValue > 0
    ? `효과${t.effectType} ${fmtNum(t.effectValue)}${EFFECT_UNIT[t.effectType]}`
    : "";

// 업체 단위 집계. 금액과 시간은 단위가 달라 각각 따로 더한다.
const tallyEffects = (participants) => {
  const t = { 금액: 0, 시간: 0, headcount: 0, byScope: {}, withEffect: 0, total: 0 };
  (participants || []).forEach((p) => {
    (p.tasks || []).forEach((task) => {
      t.total++;
      if (task.scope) t.byScope[task.scope] = (t.byScope[task.scope] || 0) + 1;
      if (task.headcount > 0) t.headcount += task.headcount;
      if (task.effectType && task.effectValue > 0) {
        t[task.effectType] += task.effectValue;
        t.withEffect++;
      }
    });
  });
  return t;
};

/* 과제의 범위·인원·효과 입력 필드. 추가 모달과 인라인 수정에서 같이 쓴다. */
function TaskMetaFields({ value, onChange, compact }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const cls = `w-full px-3 ${compact ? "py-1.5 text-xs" : "py-2 text-sm"} bg-white border border-slate-200 rounded-lg outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-50 transition-all`;
  const lab = "block text-[11px] font-bold text-slate-500 mb-1";

  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className={lab}>사용인력</label>
        <select value={value.scope} onChange={(e) => set("scope", e.target.value)} className={cls}>
          <option value="">선택 안 함</option>
          {TASK_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label className={lab}>적용 인원 (명)</label>
        <input type="number" min={0} value={value.headcount}
          onChange={(e) => set("headcount", e.target.value)} placeholder="예: 12" className={cls} />
      </div>
      <div>
        <label className={lab}>효과 유형</label>
        <select value={value.effectType}
          onChange={(e) => set("effectType", e.target.value)} className={cls}>
          <option value="">선택 안 함</option>
          {EFFECT_TYPES.map((s) => <option key={s} value={s}>효과{s}</option>)}
        </select>
      </div>
      <div>
        <label className={lab}>
          효과 값 {value.effectType ? `(${EFFECT_UNIT[value.effectType]})` : ""}
        </label>
        <input type="number" min={0} value={value.effectValue} disabled={!value.effectType}
          onChange={(e) => set("effectValue", e.target.value)}
          placeholder={value.effectType === "시간" ? "예: 40" : "예: 12000000"}
          className={`${cls} ${!value.effectType ? "bg-slate-50 text-slate-300 cursor-not-allowed" : ""}`} />
      </div>
    </div>
  );
}

/* 업체 허브 헤더에 붙는 효과 집계 줄.
   리포트의 '▸ 효과 집계' / '▸ 적용 범위' 와 같은 숫자를 같은 규칙으로 계산한다. */
function CompanyEffectSummary({ participants }) {
  const t = tallyEffects(participants);
  if (t.total === 0) return null;

  const chips = [];
  if (t.금액 > 0) chips.push({ text: `💰 ${fmtNum(t.금액)}원`, cls: "bg-emerald-50 text-emerald-700 border-emerald-100" });
  if (t.시간 > 0) chips.push({ text: `⏱ ${fmtNum(t.시간)}시간`, cls: "bg-amber-50 text-amber-700 border-amber-100" });
  if (t.headcount > 0) chips.push({ text: `👥 적용 ${fmtNum(t.headcount)}명`, cls: "bg-sky-50 text-sky-700 border-sky-100" });

  const scopeText = TASK_SCOPES.filter((s) => t.byScope[s]).map((s) => `${s} ${t.byScope[s]}`).join(" · ");

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {chips.length > 0 ? (
        chips.map((c, i) => (
          <span key={i} className={`px-2 py-0.5 rounded-md text-[11px] font-bold border ${c.cls}`}>{c.text}</span>
        ))
      ) : (
        <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold border bg-slate-50 text-slate-400 border-slate-100">
          효과 미입력
        </span>
      )}
      <span className="text-[11px] text-slate-400">
        과제 {t.total}건 중 {t.withEffect}건 입력{scopeText ? ` · ${scopeText}` : ""}
      </span>
    </div>
  );
}

/* 과제 줄 아래에 붙는 요약 칩 */
function TaskMetaChips({ task }) {
  const chips = [];
  if (task.scope) chips.push({ text: task.scope, cls: "bg-violet-50 text-violet-600 border-violet-100" });
  if (task.headcount > 0) chips.push({ text: `${fmtNum(task.headcount)}명`, cls: "bg-sky-50 text-sky-600 border-sky-100" });
  const eff = effectLabel(task);
  if (eff) chips.push({ text: eff, cls: "bg-emerald-50 text-emerald-700 border-emerald-100" });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {chips.map((c, i) => (
        <span key={i} className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${c.cls}`}>{c.text}</span>
      ))}
    </div>
  );
}

const sBadge = (s) =>
  s === "정상"
    ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
    : "bg-amber-100 text-amber-700 border border-amber-200";

const DeltaEl = ({ d }) =>
  d > 0 ? <span className="text-emerald-600 font-bold text-xs">+{d}%↑</span>
    : d < 0 ? <span className="text-rose-500 font-bold text-xs">{d}%↓</span>
      : <span className="text-slate-400 text-xs">0%</span>;

/* ═══════════════════════════════════════════════════
   공용 컴포넌트
═══════════════════════════════════════════════════ */
function PBar({ v }) {
  return (
    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
      <div className={`h-2 rounded-full transition-all duration-500 ${pColor(v)}`} style={{ width: `${v}%` }} />
    </div>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

/* ─── 업체 추가 모달 ─────────────────────────────── */
function AddCompanyModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const handle = () => { if (!name.trim()) return; onAdd(name.trim()); onClose(); };
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 bg-violet-100 rounded-xl flex items-center justify-center text-lg">🏢</div>
          <h3 className="text-base font-bold text-slate-800">신규 업체 추가</h3>
        </div>
        <label className="text-xs text-slate-500 font-semibold mb-1.5 block">업체명</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handle()} placeholder="예: 삼성전자"
          className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl mb-5 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 transition-all" />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={handle} className="px-5 py-2 text-sm text-white bg-violet-500 rounded-xl hover:bg-violet-600 transition-colors font-semibold">추가</button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 업체 삭제 경고 모달 ─────────────────────────── */
function DeleteCompanyModal({ company, onConfirm, onClose }) {
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[420px] mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-rose-100 rounded-full flex items-center justify-center text-2xl">⚠️</div>
          <div>
            <h3 className="text-base font-bold text-slate-800">업체 삭제</h3>
            <p className="text-xs text-slate-400">이 작업은 되돌릴 수 없습니다</p>
          </div>
        </div>
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-4 mb-5 space-y-1">
          <p className="text-sm text-slate-700">
            <span className="font-bold text-rose-600">'{company.name}'</span> 업체를 삭제합니다.
          </p>
          <p className="text-sm text-slate-600">
            소속 참여자 <span className="font-bold text-rose-600">{company.participants.length}명</span>의
            모든 과제·보고·채팅 데이터가 영구 삭제됩니다.
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={onConfirm} className="px-5 py-2 text-sm text-white bg-rose-500 rounded-xl hover:bg-rose-600 transition-colors font-semibold flex items-center gap-1.5">
            🗑 삭제 확인
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 참여자 삭제 경고 모달 ───────────────────────── */
function DeleteParticipantModal({ participant, onConfirm, onClose }) {
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[420px] mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-rose-100 rounded-full flex items-center justify-center text-2xl">⚠️</div>
          <div>
            <h3 className="text-base font-bold text-slate-800">참여자 삭제</h3>
            <p className="text-xs text-slate-400">이 작업은 되돌릴 수 없습니다</p>
          </div>
        </div>
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-4 mb-5 space-y-1">
          <p className="text-sm text-slate-700">
            <span className="font-bold text-rose-600">'{participant.name}'</span> 참여자를 삭제합니다.
          </p>
          <p className="text-sm text-slate-600 font-semibold text-rose-600 mt-2">
            참여자의 모든 정보가 사라집니다. 정말 삭제하시겠습니까?
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={onConfirm} className="px-5 py-2 text-sm text-white bg-rose-500 rounded-xl hover:bg-rose-600 transition-colors font-semibold flex items-center gap-1.5">
            🗑 삭제 확인
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 과제 추가 모달 ─────────────────────────────── */
function AddTaskModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const [meta, setMeta] = useState(emptyTaskMeta);
  const handle = () => { if (!name.trim()) return; onAdd(name.trim(), normalizeTaskMeta(meta)); onClose(); };
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 bg-emerald-100 rounded-xl flex items-center justify-center text-lg">🛠️</div>
          <h3 className="text-base font-bold text-slate-800">과제 추가</h3>
        </div>
        <label className="text-xs text-slate-500 font-semibold mb-1.5 block">과제명</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handle()} placeholder="예: 데이터 전처리 파이프라인"
          className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl mb-4 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all" />
        <TaskMetaFields value={meta} onChange={setMeta} />
        <p className="text-[11px] text-slate-400 mt-2 mb-5 leading-relaxed">
          나중에 ✏️ 로 언제든 바꿀 수 있습니다. 효과는 금액·시간 중 하나만 고릅니다.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={handle} className="px-5 py-2 text-sm text-white bg-emerald-500 rounded-xl hover:bg-emerald-600 transition-colors font-semibold">추가</button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 참여자 신규 등록 모달 ─────────────────────── */
function AddParticipantModal({ onAdd, onClose }) {
  const [form, setForm] = useState({ name: "", dept: "", email: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.name.trim() && form.dept.trim();
  const handle = () => {
    if (!valid) return;
    onAdd({ name: form.name.trim(), dept: form.dept.trim(), email: form.email.trim() });
    onClose();
  };
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[440px] mx-4 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 bg-sky-100 rounded-xl flex items-center justify-center text-lg">👤</div>
          <div>
            <h3 className="text-base font-bold text-slate-800">참여자 신규 등록</h3>
            <p className="text-xs text-slate-400 mt-0.5">본인 정보를 직접 입력해 주세요</p>
          </div>
        </div>
        <div className="space-y-3 mb-5">
          <div>
            <label className="text-xs text-slate-500 font-semibold mb-1 block">이름 <span className="text-rose-400">*</span></label>
            <input autoFocus value={form.name} onChange={(e) => set("name", e.target.value)}
              placeholder="예: 홍길동"
              className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all" />
          </div>
          <div>
            <label className="text-xs text-slate-500 font-semibold mb-1 block">부서 <span className="text-rose-400">*</span></label>
            <input value={form.dept} onChange={(e) => set("dept", e.target.value)}
              placeholder="예: AI 개발팀"
              className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all" />
          </div>
          <div>
            <label className="text-xs text-slate-500 font-semibold mb-1 block">이메일</label>
            <input value={form.email} onChange={(e) => set("email", e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handle()}
              placeholder="예: hong@company.com"
              className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all" />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={handle} disabled={!valid}
            className={`px-5 py-2 text-sm text-white rounded-xl font-semibold transition-colors
              ${valid ? "bg-sky-500 hover:bg-sky-600" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
            등록
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 일정 편집 모달 (관리자 전용) ──────────────────── */
function ScheduleEditModal({ company, onSave, onClose }) {
  const s = company.schedule || {};
  const [form, setForm] = useState({
    startDate: s.startDate || "",
    kickoffDate: s.kickoffDate || "",
    endDate: s.endDate || "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.startDate && form.endDate;

  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[460px] mx-4 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center text-xl">📅</div>
          <div>
            <h3 className="text-base font-bold text-slate-800">프로젝트 일정 설정</h3>
            <p className="text-xs text-slate-400 mt-0.5">{company.name}</p>
          </div>
        </div>
        <div className="space-y-4 mb-5">
          {[
            { key: "startDate", label: "🚀 과제 시작일", color: "border-emerald-400 focus:ring-emerald-50" },
            { key: "kickoffDate", label: "🎯 KickOff 일자", color: "border-amber-400 focus:ring-amber-50" },
            { key: "endDate", label: "🏁 종료 일자", color: "border-rose-400 focus:ring-rose-50" },
          ].map(({ key, label, color }) => (
            <div key={key}>
              <label className="text-xs font-semibold text-slate-500 mb-1.5 block">{label}</label>
              <input type="date" value={form[key]} onChange={(e) => set(key, e.target.value)}
                className={`w-full px-4 py-2.5 text-sm border-2 ${color} rounded-xl outline-none focus:ring-2 transition-all`} />
            </div>
          ))}
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button onClick={() => { if (valid) { onSave(form); onClose(); } }} disabled={!valid}
            className={`px-5 py-2 text-sm text-white rounded-xl font-semibold transition-colors ${valid ? "bg-indigo-500 hover:bg-indigo-600" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
            저장
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 관리자 비밀번호 변경 모달 ───────────────────── */
function AdminPasswordModal({ adminAuth, onSaved, onClose }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (next.length < 8) return setErr("새 비밀번호는 8자 이상이어야 합니다.");
    if (next !== confirm) return setErr("새 비밀번호가 일치하지 않습니다.");
    if (next === LEGACY_ADMIN_PWD) return setErr("기본 비밀번호는 사용할 수 없습니다.");

    setBusy(true);
    try {
      const ok = await verifyAdminPassword(cur, adminAuth);
      if (!ok) { setErr("현재 비밀번호가 올바르지 않습니다."); return; }

      const salt = newSaltHex();
      const hash = await derivePassword(next, salt, PBKDF2_ITERATIONS);
      const record = { hash, salt, iterations: PBKDF2_ITERATIONS };

      // config는 companies와 별도 문서라 명단 저장 가드의 영향을 받지 않는다.
      await setDoc(doc(db, ...CONFIG_DOC), {
        adminPasswordHash: hash,
        adminPasswordSalt: salt,
        adminPasswordIterations: PBKDF2_ITERATIONS,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      onSaved(record);
      onClose();
    } catch (e2) {
      console.error("[admin-password]", e2);
      setErr(e2.message || "저장에 실패했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const field = (label, val, set, autoFocus = false) => (
    <div>
      <label className="block text-xs font-bold text-slate-500 mb-1.5">{label}</label>
      <input type="password" value={val} autoFocus={autoFocus} onChange={(e) => set(e.target.value)}
        className="w-full px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
    </div>
  );

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-[420px] mx-4 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-violet-100 rounded-xl flex items-center justify-center text-xl">🔑</div>
          <div>
            <h3 className="text-base font-bold text-slate-800">관리자 비밀번호 변경</h3>
            <p className="text-xs text-slate-400">모든 관리자 계정에 즉시 적용됩니다</p>
          </div>
        </div>

        {!adminAuth?.hash && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed">
            현재 기본 비밀번호를 쓰고 있습니다. 이 값은 공개 저장소와 배포 번들에 노출되어 있으니 반드시 변경해 주세요.
          </p>
        )}

        {field(adminAuth?.hash ? "현재 비밀번호" : "현재 비밀번호 (기본값)", cur, setCur, true)}
        {field("새 비밀번호 (8자 이상)", next, setNext)}
        {field("새 비밀번호 확인", confirm, setConfirm)}

        {err && <p className="text-rose-500 text-xs font-bold">{err}</p>}

        <p className="text-[11px] text-slate-400 leading-relaxed">
          비밀번호는 무작위 솔트를 붙여 PBKDF2-SHA256으로 {PBKDF2_ITERATIONS.toLocaleString()}회 늘려 저장하며
          평문은 어디에도 남지 않습니다. 검증은 클라이언트에서 이뤄지므로, 외부 접근 차단은
          Firestore 보안 규칙과 App Check 적용이 함께 필요합니다.
        </p>

        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">취소</button>
          <button type="submit" disabled={busy}
            className={`px-5 py-2 text-sm text-white rounded-xl font-semibold transition-colors ${busy ? "bg-slate-300 cursor-not-allowed" : "bg-violet-500 hover:bg-violet-600"}`}>
            {busy ? "저장 중..." : "변경하기"}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

/* ─── 참여자 백업 / 복구 모달 ─────────────────────
   백업처는 구글 시트 '참여자' 시트 하나로 통일했다.
   예전에는 여기서 JSON 파일을 내려받고 툴바에 '참여자 업데이트' 버튼이 따로 있어
   같은 명단을 두 곳으로 내보내는 꼴이었다. 파일은 PC에 묶이고 잃어버리기 쉬워서 없앴다.
   복구원은 둘: 브라우저에 쌓이는 자동 스냅샷, 그리고 시트에서 복사해 붙여넣기. */

// 구글 시트를 직접 읽어온다. GAS 의 doGet 이 CORS 헤더를 붙여줘서 그냥 fetch 로 된다.
// 응답: { status, participants:[{company,dept,name,email}], companies:[{name,startDate,kickoffDate,endDate}] }
const fetchRosterFromSheets = async () => {
  const res = await fetch(`${GAS_URL}?action=getRoster`, { redirect: "follow" });
  if (!res.ok) throw new Error(`시트를 불러오지 못했습니다 (HTTP ${res.status})`);

  let data;
  try {
    data = await res.json();
  } catch {
    // 배포가 옛 버전이면 '함수를 찾을 수 없습니다' HTML 이 돌아온다
    throw new Error("시트 응답을 읽지 못했습니다. Apps Script 가 최신 버전으로 배포됐는지 확인해 주세요.");
  }
  if (data.status !== "ok") throw new Error(data.message || "시트에서 오류가 반환되었습니다.");

  const schedules = new Map(
    (data.companies || []).map((c) => [c.name, c])
  );
  const byCompany = new Map();
  for (const p of data.participants || []) {
    if (!p.company || !p.name) continue;
    if (!byCompany.has(p.company)) byCompany.set(p.company, []);
    byCompany.get(p.company).push({ name: p.name, dept: p.dept || "", email: p.email || "" });
  }
  if (!byCompany.size) throw new Error("'참여자' 시트가 비어 있습니다. 먼저 백업을 한 번 실행해 주세요.");

  return {
    version: BACKUP_VERSION,
    exportedAt: data.exportedAt || new Date().toISOString(),
    skipped: 0,
    companies: [...byCompany].map(([name, participants]) => {
      const s = schedules.get(name);
      const schedule = s && (s.startDate || s.endDate)
        ? { startDate: s.startDate, kickoffDate: s.kickoffDate, endDate: s.endDate }
        : null;
      return { name, schedule, participants };
    }),
  };
};

// 구글 시트에서 복사한 행을 파싱한다. 시트 복사는 탭 구분, 손으로 옮기면 쉼표일 수 있다.
// 기대 열 순서: 업체 / 팀(부서) / 이름 / 이메일 — updateParticipantsToGoogleSheets 가 쓰는 순서와 같다.
const parseSheetRoster = (text) => {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.includes("\t") ? l.split("\t") : l.split(",")).map((c) => c.trim()));

  if (!rows.length) throw new Error("붙여넣은 내용이 없습니다.");

  const body = rows.filter((r) => !/^(업체|회사|company)$/i.test(r[0] || ""));

  const byCompany = new Map();
  let skipped = 0;
  for (const r of body) {
    const company = r[0] || "", dept = r[1] || "", name = r[2] || "", email = r[3] || "";
    if (!company || !name) { skipped++; continue; }
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push({ name, dept, email });
  }
  if (!byCompany.size) {
    throw new Error("업체·이름을 읽지 못했습니다. 시트의 업체/팀/이름/이메일 4개 열을 그대로 복사해 주세요.");
  }
  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    skipped,
    companies: [...byCompany].map(([name, participants]) => ({ name, schedule: null, participants })),
  };
};

function BackupRestoreModal({ companies, onRestore, onClose }) {
  const [mode, setMode] = useState("backup"); // "backup" | "restore"
  const [pending, setPending] = useState(null); // { backup, diff, source }
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);
  const snapshots = readLocalSnapshots();
  const total = countParticipants(companies);

  const [loading, setLoading] = useState(false);

  const stage = async (parse, source) => {
    setErr("");
    setLoading(true);
    try {
      const backup = await parse();
      setPending({ backup, diff: diffRosterBackup(backup, companies), source });
    } catch (e) {
      setPending(null);
      setErr(e.message || "내용을 읽을 수 없습니다.");
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      await onRestore(pending.backup);
      onClose();
    } catch (e) {
      setErr(e.message || "복구에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const canApply = pending && (pending.diff.newParticipants.length > 0 || pending.diff.newCompanies.length > 0);

  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[560px] mx-4 max-h-[86vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center text-xl">👥</div>
            <div>
              <h3 className="text-base font-bold text-slate-800">참여자 백업 · 복구</h3>
              <p className="text-xs text-slate-400">업체 · 부서 · 이름 · 이메일 (과제·진척도 제외)</p>
            </div>
          </div>
          <div className="flex gap-1 mt-4">
            {[["backup", "☁️ 백업"], ["restore", "♻️ 복구"]].map(([id, label]) => (
              <button key={id} onClick={() => { setMode(id); setErr(""); setPending(null); }}
                className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors ${mode === id ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto space-y-4">
          {err && <p className="text-rose-600 text-xs font-bold bg-rose-50 border border-rose-100 rounded-lg p-2.5">{err}</p>}

          {mode === "backup" && (
            <>
              <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 text-sm text-slate-600">
                업체 <b className="text-slate-800">{companies.length}개</b> · 참여자 <b className="text-slate-800">{total}명</b>
              </div>
              <button
                onClick={() => updateParticipantsToGoogleSheets(companies, setPushing)}
                disabled={pushing || total === 0}
                className={`w-full py-3 rounded-xl font-bold text-sm text-white transition-opacity ${pushing || total === 0 ? "bg-slate-300 cursor-not-allowed" : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:opacity-90"}`}>
                {pushing ? "백업 중..." : "☁️ 구글 시트에 백업"}
              </button>
              <p className="text-xs text-slate-400 leading-relaxed">
                구글 스프레드시트의 <b>&apos;참여자&apos;</b> 시트에 업체 · 팀 · 이름 · 이메일이 기록됩니다.
                복구할 때 그 시트를 그대로 복사해 붙여넣으면 됩니다.
              </p>
              <p className="text-xs text-slate-400 leading-relaxed border-t border-slate-100 pt-3">
                관리자로 접속할 때마다 이 브라우저에도 명단 스냅샷이 자동 보관됩니다.
                현재 <b className="text-slate-600">{snapshots.length}개</b> 보관 중이며 복구 탭에서 바로 되돌릴 수 있습니다.
              </p>
            </>
          )}

          {mode === "restore" && !pending && (
            <>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2">구글 시트에서 불러오기</label>
                <button onClick={() => stage(fetchRosterFromSheets, "구글 시트")}
                  disabled={loading}
                  className={`w-full py-3 rounded-xl font-bold text-sm text-white transition-opacity ${loading ? "bg-slate-300 cursor-not-allowed" : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:opacity-90"}`}>
                  {loading ? "불러오는 중..." : "☁️ 시트에서 바로 불러오기"}
                </button>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                  &apos;참여자&apos; 시트를 그대로 읽어옵니다. &apos;업체&apos; 시트가 있으면 일정도 함께 가져옵니다.
                </p>
              </div>

              {snapshots.length > 0 && (
                <div className="border-t border-slate-100 pt-4">
                  <label className="block text-xs font-bold text-slate-500 mb-2">이 브라우저의 자동 스냅샷</label>
                  <div className="space-y-1.5">
                    {snapshots.map((s, i) => (
                      <button key={i} onClick={() => stage(() => parseRosterBackup(s), `자동 스냅샷 #${i + 1}`)}
                        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 hover:bg-emerald-50 border border-slate-100 hover:border-emerald-200 rounded-xl text-left transition-colors">
                        <span className="text-xs font-semibold text-slate-600">{new Date(s.exportedAt).toLocaleString("ko-KR")}</span>
                        <span className="text-xs text-slate-400">업체 {s.companies.length} · 참여자 {countParticipants(s.companies)}명</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="border-t border-slate-100 pt-4">
                <label className="block text-xs font-bold text-slate-500 mb-2">구글 시트에서 붙여넣기</label>
                <p className="text-xs text-slate-400 mb-2 leading-relaxed">
                  <b>&apos;참여자&apos;</b> 시트에서 업체 · 팀 · 이름 · 이메일 네 열을 선택해 복사한 뒤 아래에 붙여넣으세요. 머리글 행은 있어도 됩니다.
                </p>
                <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={6}
                  placeholder={"성우전자\t제조그룹\t권민수\tmskwon@swei.co.kr\n성우전자\t기획그룹\t홍성락\traphae4@swei.co.kr"}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-50 transition-all resize-none" />
                <button onClick={() => stage(() => parseSheetRoster(paste), "구글 시트 붙여넣기")}
                  disabled={!paste.trim()}
                  className={`mt-2 w-full py-2 rounded-xl text-sm font-bold transition-colors ${paste.trim() ? "bg-slate-700 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
                  내용 확인
                </button>
              </div>
            </>
          )}

          {mode === "restore" && pending && (
            <>
              <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 space-y-1.5">
                <p className="text-xs text-slate-500">출처: <b className="text-slate-700">{pending.source}</b></p>
                {pending.backup.skipped > 0 && (
                  <p className="text-xs text-amber-700">업체·이름이 비어 건너뛴 행 {pending.backup.skipped}개</p>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ["신규 참여자", pending.diff.newParticipants.length, "text-emerald-600"],
                  ["신규 업체", pending.diff.newCompanies.length, "text-violet-600"],
                  ["이미 존재", pending.diff.existing, "text-slate-400"],
                ].map(([label, n, color]) => (
                  <div key={label} className="bg-white border border-slate-100 rounded-xl py-3">
                    <div className={`text-xl font-extrabold ${color}`}>{n}</div>
                    <div className="text-[11px] text-slate-400 font-semibold mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg p-2.5 leading-relaxed">
                ✅ <b>추가만</b> 수행합니다. 이미 있는 참여자의 과제·진척도·요약·메모는 전혀 건드리지 않습니다.
              </p>
              {pending.diff.newParticipants.length > 0 && (
                <div className="border border-slate-100 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 text-xs font-bold text-slate-500">추가될 참여자</div>
                  <div className="max-h-52 overflow-y-auto divide-y divide-slate-50">
                    {pending.diff.newParticipants.map((p, i) => (
                      <div key={i} className="px-4 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-700 truncate">{p.name} <span className="text-xs text-slate-400">/ {p.dept}</span></div>
                          <div className="text-xs text-slate-400 truncate">{p.email || "이메일 없음"}</div>
                        </div>
                        <span className="text-xs text-slate-500 font-semibold shrink-0">{p.company}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!canApply && (
                <p className="text-sm text-slate-500 text-center py-4">추가할 항목이 없습니다. 이미 모두 등록되어 있습니다.</p>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex gap-2 justify-end shrink-0">
          {pending && (
            <button onClick={() => setPending(null)}
              className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">다시 선택</button>
          )}
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">닫기</button>
          {pending && (
            <button onClick={apply} disabled={busy || !canApply}
              className={`px-5 py-2 text-sm text-white rounded-xl font-semibold transition-colors ${busy || !canApply ? "bg-slate-300 cursor-not-allowed" : "bg-emerald-500 hover:bg-emerald-600"}`}>
              {busy ? "복구 중..." : "♻️ 복구 실행"}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/* ─── 통합 로그인 화면 ────────────────────────────── */
function LoginScreen({ companies, onLogin, onRegister, adminAuth }) {
  const [tab, setTab] = useState("admin"); // "admin" | "participant"

  // 관리자 폼
  const [adminPwd, setAdminPwd] = useState("");
  const [adminErr, setAdminErr] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);

  // 참여자 폼
  const [pForm, setPForm] = useState({ cid: companies[0]?.id || "", name: "", email: "", dept: "" });
  const [pErr, setPErr] = useState("");
  const [showRegister, setShowRegister] = useState(false);

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setAdminErr("");
    setAdminBusy(true);
    try {
      // 비밀번호는 소스에 두지 않고 dashboard/config 문서에 PBKDF2 해시로 보관한다.
      // 해시가 아직 없는 환경(최초 도입 직후)에서만 레거시 비밀번호를 허용한다.
      const ok = await verifyAdminPassword(adminPwd, adminAuth);
      if (ok) onLogin({ role: "admin", needsPasswordSetup: !adminAuth?.hash });
      else setAdminErr("비밀번호가 올바르지 않습니다.");
    } catch (err) {
      setAdminErr(err.message || "로그인 처리 중 오류가 발생했습니다.");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleParticipantSubmit = async (e) => {
    e.preventDefault();
    setPErr("");
    if (!pForm.cid || !pForm.name.trim() || !pForm.email.trim()) {
      setPErr("모든 필드를 입력해 주세요.");
      return;
    }
    const c = companies.find(co => co.id === pForm.cid);
    const existing = c?.participants.find(p => p.name === pForm.name.trim() && p.email === pForm.email.trim());

    if (existing) {
      onLogin({ role: "participant", id: existing.id, cid: pForm.cid });
    } else {
      if (!showRegister) {
        setShowRegister(true);
        setPErr("등록되지 않은 사용자입니다. 소속 부서를 입력하고 신규 등록해 주세요.");
      } else {
        if (!pForm.dept.trim()) {
          setPErr("신규 등록 시 부서명은 필수입니다.");
          return;
        }
        // 서버 저장이 확정된 뒤에만 로그인시킨다.
        // 예전에는 저장 성공 여부와 무관하게 50ms 뒤 무조건 로그인해서,
        // 저장이 실패해도 본인은 등록된 줄 알고 넘어갔다.
        const newId = uid();
        const res = await onRegister(pForm.cid, {
          id: newId, name: pForm.name.trim(), email: pForm.email.trim(), dept: pForm.dept.trim(),
        });
        if (res && res.ok === false) {
          setPErr(`등록에 실패했습니다. ${res.error?.message || "잠시 후 다시 시도해 주세요."}`);
          return;
        }
        // 방금 고른 업체 id 를 함께 넘긴다. App 쪽 companies 가 아직 갱신 전일 수 있다.
        onLogin({ role: "participant", id: newId, cid: pForm.cid });
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-slate-100 w-full max-w-md overflow-hidden">
        {/* 헤더 */}
        <div className="bg-gradient-to-br from-violet-600 to-indigo-700 px-8 py-10 text-center text-white">
          <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center text-3xl font-black mx-auto mb-4 tracking-tighter shadow-inner">
            AI
          </div>
          <h1 className="text-2xl font-bold tracking-tight">AI 프로젝트 대시보드</h1>
          <p className="opacity-80 mt-2 text-sm">실습 현황 통합 모니터링 시스템</p>
        </div>

        {/* 탭 */}
        <div className="flex border-b border-slate-100">
          <button onClick={() => { setTab("admin"); setAdminErr(""); setAdminPwd(""); }}
            className={`flex-1 py-4 text-sm font-bold transition-all ${tab === "admin" ? "bg-violet-50 text-violet-700 border-b-2 border-violet-600" : "text-slate-500 hover:bg-slate-50"}`}>
            🔑 관리자 (강사)
          </button>
          <button onClick={() => { setTab("participant"); setPErr(""); setShowRegister(false); }}
            className={`flex-1 py-4 text-sm font-bold transition-all ${tab === "participant" ? "bg-sky-50 text-sky-700 border-b-2 border-sky-600" : "text-slate-500 hover:bg-slate-50"}`}>
            👤 참여자 (수강생)
          </button>
        </div>

        {/* 폼 영역 */}
        <div className="p-8">
          {tab === "admin" && (
            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2">관리자 비밀번호</label>
                <input type="password" value={adminPwd} onChange={(e) => setAdminPwd(e.target.value)}
                  placeholder="비밀번호를 입력하세요"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
              </div>
              {adminErr && <p className="text-rose-500 text-xs font-bold">{adminErr}</p>}
              {!adminAuth?.hash && (
                <p className="text-amber-600 text-xs font-semibold bg-amber-50 border border-amber-200 rounded-lg p-2.5 leading-relaxed">
                  ⚠️ 관리자 비밀번호가 아직 설정되지 않았습니다. 접속 후 <b>🔑 비밀번호 변경</b>에서 즉시 변경해 주세요.
                </p>
              )}
              <button type="submit" disabled={adminBusy}
                className={`w-full py-3 mt-4 text-white font-bold rounded-xl transition-colors shadow-sm ${adminBusy ? "bg-slate-300 cursor-not-allowed" : "bg-violet-600 hover:bg-violet-700"}`}>
                {adminBusy ? "확인 중..." : "접속하기"}
              </button>
            </form>
          )}

          {tab === "participant" && (
            <form onSubmit={handleParticipantSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-2">소속 업체</label>
                <select value={pForm.cid} onChange={(e) => setPForm({ ...pForm, cid: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all text-slate-700 font-medium">
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-2">이름</label>
                  <input type="text" value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })}
                    placeholder="홍길동"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all font-medium" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-2">이메일</label>
                  <input type="email" value={pForm.email} onChange={(e) => setPForm({ ...pForm, email: e.target.value })}
                    placeholder="user@email.com"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 transition-all font-medium" />
                </div>
              </div>

              {showRegister && (
                <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                  <label className="block text-xs font-bold text-amber-600 mb-2">🌟 신규 사용자 부서명 (필수)</label>
                  <input type="text" value={pForm.dept} onChange={(e) => setPForm({ ...pForm, dept: e.target.value })}
                    placeholder="DX추진팀" autoFocus
                    className="w-full px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium" />
                </div>
              )}

              {pErr && (
                <div className={`p-3 rounded-xl text-xs font-bold leading-relaxed ${showRegister ? "bg-amber-100 text-amber-800" : "bg-rose-50 text-rose-600"}`}>
                  {pErr}
                </div>
              )}

              <button type="submit"
                className={`w-full py-3 mt-4 text-white font-bold rounded-xl transition-colors shadow-sm ${showRegister ? "bg-amber-500 hover:bg-amber-600" : "bg-sky-500 hover:bg-sky-600"}`}>
                {showRegister ? "신규 등록하고 접속" : "접속하기"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
// 동적 주차 계산 로직 (매주 월요일 자정 기준 증가)
// 2026년 2월 23일(월요일)을 9주차 기준으로 삼음
const getCurrentConsultingWeek = () => {
  const baseDate = new Date("2026-02-23T00:00:00+09:00");
  const baseWeekNumber = 9;
  const now = new Date();

  if (now < baseDate) return baseWeekNumber;

  const diffTime = Math.abs(now - baseDate);
  const diffWeeks = Math.floor(diffTime / (1000 * 60 * 60 * 24 * 7));

  return baseWeekNumber + diffWeeks;
};

function ReportModal({ company, onClose }) {
  const today = new Date().toLocaleDateString("ko-KR");
  const defaultWeek = getCurrentConsultingWeek().toString();
  const [targetWeek, setTargetWeek] = useState(defaultWeek);
  const [isExporting, setIsExporting] = useState(false);
  const [adminMemo, setAdminMemo] = useState("주요 일정 / 컨설팅 운영 방안 / 최근 벤치마크 순위 / 실습용 과제 샘플 소개");

  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col">
        {/* 헤더 */}
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-slate-800">📋 {company.name} — AI 주간 레포트</h3>
              <span className="text-xs bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full font-semibold">관리자 전용</span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">발행일: {today} · 참여자 {company.participants.length}명</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 h-full">
                <span className="text-xs font-bold text-slate-500 mr-2">주차:</span>
                <input type="number" value={targetWeek} onChange={e => setTargetWeek(e.target.value)}
                  className="w-10 text-xs font-bold bg-transparent outline-none focus:text-indigo-600" min="1" max="52" />
              </div>
            </div>
            <button onClick={() => publishReportToGoogleSheets([company], targetWeek, setIsExporting, adminMemo)}
              disabled={isExporting}
              className={`px-4 py-2 rounded-xl text-sm font-bold text-white transition-opacity flex items-center gap-1.5 shadow-sm
                ${isExporting ? "bg-slate-400 cursor-not-allowed" : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:opacity-90"}`}>
              {isExporting ? "전송 중..." : "📊 스프레드시트 발행"}
            </button>
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors text-lg">✕</button>
          </div>
        </div>
        {/* 바디 */}
        <div className="overflow-y-auto px-6 py-5 space-y-5">
          {/* 주요 전달 내용 입력부 */}
          <div className="bg-indigo-50/50 rounded-2xl p-5 border border-indigo-100">
            <h4 className="text-sm font-bold text-indigo-800 mb-2">📢 주요 전달 내용 (공통)</h4>
            <textarea
              value={adminMemo}
              onChange={e => setAdminMemo(e.target.value)}
              className="w-full bg-white border border-indigo-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 min-h-[80px]"
              placeholder="이번 주 주요 일정, 전달 사항 등을 입력하세요. 레포트 최상단 '■ 주요 전달 내용'에 세팅됩니다."
            />
          </div>

          {company.participants.length === 0 ? (
            <p className="text-center py-10 text-slate-400 text-sm">등록된 참여자가 없습니다.</p>
          ) : company.participants.map((p) => (
            <div key={p.id} className="bg-slate-50 rounded-2xl p-5 space-y-4 border border-slate-100">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-slate-800 text-base">{p.name}</span>
                  <span className="ml-2 text-xs text-slate-400">{p.dept} · {p.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xl font-extrabold text-slate-700">{avgProgress(p)}%</span>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${sBadge(p.status)}`}>
                    {p.status === "정상" ? "🟢 정상" : "⚠️ 정체"}
                  </span>
                </div>
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-2">📋 과제 현황</p>
                <div className="space-y-2">
                  {p.tasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-3">
                      <span className="text-xs text-slate-600 w-44 shrink-0 truncate">{t.name}</span>
                      <div className="flex-1"><PBar v={t.progress} /></div>
                      <span className="text-xs font-bold text-slate-600 w-8 text-right">{t.progress}%</span>
                      <DeltaEl d={t.delta} />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1.5">📝 금주 요약 보고</p>
                <p className="text-sm text-slate-600 leading-relaxed">{p.summary}</p>
              </div>
              <div className="bg-indigo-50 border-l-4 border-indigo-400 rounded-r-xl p-4">
                <p className="text-xs font-bold text-indigo-600 mb-1.5">🤖 AI 컨설팅 레포트</p>
                <p className="text-sm text-indigo-900 leading-relaxed">{p.aiReport}</p>
              </div>
              <div>
                <p className="text-xs font-bold text-slate-500 mb-1">✏️ 강사 피드백</p>
                <p className="text-sm text-slate-600">{p.instructorMemo}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

/* ═══════════════════════════════════════════════════
   통계 카드
═══════════════════════════════════════════════════ */
function StatCard({ label, value, icon, gradient }) {
  return (
    <div className={`bg-gradient-to-br ${gradient} rounded-2xl p-5 text-white shadow-sm`}>
      <div className="text-2xl mb-2">{icon}</div>
      <div className="text-3xl font-extrabold">{value}</div>
      <div className="text-sm opacity-80 mt-1">{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 1 — 강사 관제 센터 (관리자 전용)
═══════════════════════════════════════════════════ */
// 2026-09-09 재배포: doGet(시트 → JSON 읽기)과 '업체' 시트 기록이 추가된 버전
const GAS_URL = "https://script.google.com/macros/s/AKfycbyEywx3NhTeh5RZFwzGPX0zdbGQyR1Mg_vACzwMjLJEp7JjrBATEDbNIfqFVknxWVs/exec";

async function publishReportToGoogleSheets(companies, targetWeek, setExporting, adminMemo = "") {
  setExporting(true);
  try {
    // 1. 업체별 데이터 포맷 정제
    let reports = [];

    companies.forEach(company => {
      let departmentStats = {};

      company.participants.forEach(p => {
        // 부서별 카운트 산정
        const dept = p.dept || "기타";
        if (!departmentStats[dept]) {
          departmentStats[dept] = { total: 0, completed: 0, inProgress: 0 };
        }

        if (p.tasks.length > 0) {
          departmentStats[dept].total += p.tasks.length;
          p.tasks.forEach(t => {
            if (t.progress >= 100) departmentStats[dept].completed++;
            else departmentStats[dept].inProgress++;
          });
        }
      });

      // Build Summary (금주 내용)
      let summaryText = `■ 주요전달 내용\n`;
      if (adminMemo && adminMemo.trim()) {
        const lines = adminMemo.trim().split('\n');
        lines.forEach(l => {
          summaryText += `  - ${l}\n`;
        });
        summaryText += `\n`;
      } else {
        summaryText += `  - 입력된 전달 내용이 없습니다.\n\n`;
      }

      summaryText += `■ 금주 과제 현황\n`;
      if (company.participants.length === 0) {
        summaryText += `  - 등록된 참여자가 없습니다.\n`;
      } else {
        // 효과 집계. 금액과 시간은 단위가 달라 각각 따로 더한다.
        const tally = tallyEffects(company.participants);
        const effParts = [];
        if (tally.금액 > 0) effParts.push(`금액 ${fmtNum(tally.금액)}원`);
        if (tally.시간 > 0) effParts.push(`시간 ${fmtNum(tally.시간)}시간`);
        summaryText += `  ▸ 효과 집계: ${effParts.length ? effParts.join(" · ") : "입력된 효과 없음"}`;
        summaryText += ` (전체 ${tally.total}건 중 ${tally.withEffect}건 입력)\n`;

        const scopeParts = TASK_SCOPES
          .filter((s) => tally.byScope[s])
          .map((s) => `${s} ${tally.byScope[s]}`);
        if (scopeParts.length || tally.headcount > 0) {
          summaryText += `  ▸ 적용 범위: ${scopeParts.length ? scopeParts.join(" · ") : "미입력"}`;
          if (tally.headcount > 0) summaryText += ` / 적용 인원 합 ${fmtNum(tally.headcount)}명`;
          summaryText += `\n`;
        }
        summaryText += `\n`;

        company.participants.forEach(p => {
          summaryText += `       - [${p.name}/${p.dept}] 진도율: ${avgProgress(p)}% (${p.status})\n`;
          // 과제별 범위·인원·효과를 한 줄씩
          (p.tasks || []).forEach((t) => {
            const bits = [];
            if (t.scope) bits.push(t.scope);
            if (t.headcount > 0) bits.push(`${fmtNum(t.headcount)}명`);
            const eff = effectLabel(t);
            if (eff) bits.push(eff);
            summaryText += `        · ${t.name} (${t.progress}%)${bits.length ? ` — ${bits.join(" / ")}` : ""}\n`;
          });
          if (p.summary) {
            p.summary.split('\n').forEach((line, idx) => {
              if (line.trim() !== "") {
                if (idx === 0) {
                  summaryText += `        . ${line}\n`;
                } else {
                  summaryText += `          ${line}\n`;
                }
              }
            });
          } else {
            summaryText += `        . 작성된 금주 요약이 없습니다.\n`;
          }
          summaryText += `\n`;
        });
      }

      // Build Plan (차주 내용)
      let planText = `■ 차주 계획\n`;
      if (company.participants.length === 0) {
        planText += `  - 등록된 참여자가 없습니다.\n`;
      } else {
        company.participants.forEach(p => {
          let planData = p.nextWeekPlan || "등록된 차주 계획이 없습니다.";
          planData = planData.replace(/\n/g, ' '); // 줄바꿈을 공백으로 합쳐서 한 줄 요약으로 만듦
          planText += `  -[${p.name}/${p.dept}] ${planData}\n`;
        });
      }


      reports.push({
        companyName: company.name,
        stats: departmentStats,
        summary: summaryText.trim(),
        plan: planText.trim()
      });
    });

    const payload = {
      action: "publishReport",
      week: targetWeek,
      reports: reports
    };

    // 2. Google Apps Script로 전송 (no-cors라 응답 본문은 읽을 수 없다)
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
    });

    alert(`${targetWeek}주차 레포트가 구글 스프레드시트에 성공적으로 발행되었습니다!`);
  } catch (error) {
    console.error("Export Error:", error);
    alert("레포트 발행 중 오류가 발생했습니다. 자세한 내용은 콘솔을 확인해주세요.");
  } finally {
    setExporting(false);
  }
}

async function updateParticipantsToGoogleSheets(companies, setExporting) {
  setExporting(true);
  try {
    const participants = companies.flatMap(c =>
      c.participants.map(p => ({
        company: c.name,
        dept: p.dept || "",
        name: p.name || "",
        email: p.email || ""
      }))
    );

    // 업체 일정도 함께 백업한다. 참여자 명단만으로는 일정을 복구할 수 없어서
    // 2026-09-09 에 '업체' 시트를 추가했다(파워넷사 일정이 사고로 날아간 뒤).
    const companyRows = companies.map((c) => ({
      name: c.name,
      startDate: c.schedule?.startDate || "",
      kickoffDate: c.schedule?.kickoffDate || "",
      endDate: c.schedule?.endDate || "",
    }));

    const payload = {
      action: "updateParticipants",
      participants: participants,
      companies: companyRows,
    };

    // no-cors라 응답 본문은 읽을 수 없다
    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
    });

    alert(`구글 스프레드시트에 백업했습니다.\n· '참여자' 시트: ${participants.length}명\n· '업체' 시트: ${companyRows.length}개 (일정 포함)`);
  } catch (error) {
    console.error("Export Error:", error);
    alert("참여자 업데이트 중 오류가 발생했습니다. 자세한 내용은 콘솔을 확인해주세요.");
  } finally {
    setExporting(false);
  }
}

function InstructorView({ companies, onSelectCompany, onSelectParticipant, onAddCompany, onDeleteCompany, onDeleteParticipant, onUpdateSchedule, onOpenBackup, onOpenPassword }) {
  const [showAdd, setShowAdd] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [delParticipantTarget, setDelParticipantTarget] = useState(null);
  const [schedTarget, setSchedTarget] = useState(null);
  const all = companies.flatMap((c) => c.participants.map((p) => ({ ...p, companyName: c.name, companyId: c.id })));
  const totalAvg = all.length ? Math.round(all.reduce((s, p) => s + avgProgress(p), 0) / all.length) : 0;

  return (
    <div className="space-y-6">
      {showAdd && <AddCompanyModal onAdd={onAddCompany} onClose={() => setShowAdd(false)} />}
      {delTarget && (
        <DeleteCompanyModal company={delTarget}
          onConfirm={() => { onDeleteCompany(delTarget.id); setDelTarget(null); }}
          onClose={() => setDelTarget(null)} />
      )}
      {delParticipantTarget && (
        <DeleteParticipantModal participant={delParticipantTarget}
          onConfirm={() => { onDeleteParticipant(delParticipantTarget.companyId, delParticipantTarget.id); setDelParticipantTarget(null); }}
          onClose={() => setDelParticipantTarget(null)} />
      )}
      {schedTarget && (
        <ScheduleEditModal company={schedTarget}
          onSave={(sched) => { onUpdateSchedule(schedTarget.id, sched); setSchedTarget(null); }}
          onClose={() => setSchedTarget(null)} />
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="총 업체 수" value={companies.length} icon="🏢" gradient="from-violet-400 to-purple-500" />
        <StatCard label="총 참여자" value={all.length} icon="👤" gradient="from-sky-400 to-blue-500" />
        <StatCard label="평균 진척도" value={`${totalAvg}%`} icon="📊" gradient="from-emerald-400 to-teal-500" />
      </div>

      {/* 업체별 프로젝트 일정 관리 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-700">📅 업체별 프로젝트 일정 관리</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 md:divide-x md:divide-y-0 divide-y divide-slate-100">
          {companies.map((c) => {
            const sc = c.schedule || {};
            const hasSchedule = sc.startDate && sc.endDate;
            return (
              <div key={c.id} className="px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-slate-700 text-sm">🏢 {c.name}</span>
                  <button onClick={() => setSchedTarget(c)}
                    className="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors">
                    📅 일정 설정
                  </button>
                </div>
                {hasSchedule ? (
                  <div className="space-y-1.5">
                    {[
                      { icon: "🚀", label: "과제 시작", val: sc.startDate, color: "text-emerald-600" },
                      { icon: "🎯", label: "KickOff", val: sc.kickoffDate || "미설정", color: "text-amber-600" },
                      { icon: "🏁", label: "종료", val: sc.endDate, color: "text-rose-600" },
                    ].map(({ icon, label, val, color }) => (
                      <div key={label} className="flex items-center justify-between text-xs">
                        <span className="text-slate-500">{icon} {label}</span>
                        <span className={`font-semibold ${color}`}>{val}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 text-center py-3">일정이 미등록 상태입니다.</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-700">🛰️ 전사 실습 현황 모니터링</h2>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 구글 시트 백업과 복구를 한 버튼에 모았다. 예전엔 '참여자 업데이트'가 따로 있어
                같은 명단을 시트와 로컬 파일 두 곳으로 내보내고 있었다. */}
            <button onClick={onOpenBackup} title="참여자 백업 / 복구"
              className="px-4 py-1.5 rounded-xl text-xs font-bold text-white transition-opacity flex items-center gap-1 shadow-sm bg-gradient-to-r from-emerald-500 to-teal-500 hover:opacity-90">
              👥 참여자 백업·복구
            </button>
            <button onClick={onOpenPassword} title="관리자 비밀번호 변경"
              className="px-4 py-1.5 bg-white text-slate-600 border border-slate-200 rounded-xl text-xs font-bold hover:border-violet-300 hover:text-violet-600 transition-colors flex items-center gap-1">
              🔑 비밀번호 변경
            </button>
            <button onClick={() => setShowAdd(true)}
              className="px-4 py-1.5 bg-violet-500 text-white rounded-xl text-xs font-bold hover:bg-violet-600 transition-colors flex items-center gap-1">
              ➕ 업체 추가
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-5 py-3 text-left">업체명</th>
                <th className="px-5 py-3 text-left">참여자</th>
                <th className="px-5 py-3 text-left">주요 과제</th>
                <th className="px-5 py-3 text-center">진척도</th>
                <th className="px-5 py-3 text-center">상태</th>
                <th className="px-5 py-3 text-left">강사 메모</th>
                <th className="px-5 py-3 text-center">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {all.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3.5 font-semibold text-slate-700">{p.companyName}</td>
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-slate-700">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-500">{p.tasks[0]?.name || "—"}</td>
                  <td className="px-5 py-3.5 w-44">
                    <div className="flex items-center gap-2">
                      <PBar v={avgProgress(p)} />
                      <span className="text-xs font-bold text-slate-600 w-8 shrink-0">{avgProgress(p)}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${sBadge(p.status)}`}>
                      {p.status === "정상" ? "🟢 정상" : "⚠️ 정체"}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-500 max-w-[140px] truncate">{p.instructorMemo}</td>
                  <td className="px-5 py-3.5 text-center">
                    <div className="flex items-center justify-center gap-1.5 flex-wrap">
                      <button onClick={() => { onSelectCompany(p.companyId); onSelectParticipant(p.id); }}
                        className="px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-semibold hover:bg-emerald-100 transition-colors">
                        ➕ 과제추가
                      </button>
                      <button onClick={() => { onSelectCompany(p.companyId); onSelectParticipant(p.id); }}
                        className="px-2.5 py-1 bg-violet-50 text-violet-600 rounded-lg text-xs font-semibold hover:bg-violet-100 transition-colors">
                        📑 수정
                      </button>
                      <button onClick={() => setDelParticipantTarget(p)}
                        className="px-2.5 py-1 bg-rose-50 text-rose-500 rounded-lg text-xs font-semibold hover:bg-rose-100 transition-colors">
                        ❌ 삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {all.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-14 text-center text-slate-400 text-sm">
                  등록된 업체가 없습니다.{" "}
                  <button onClick={() => setShowAdd(true)} className="text-violet-500 font-semibold underline">업체 추가</button>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 2 — 업체 허브  (레포트 버튼은 isAdmin일 때만)
═══════════════════════════════════════════════════ */
function CompanyHub({ company, isAdmin, onSelectParticipant, onAddParticipant, onAddChat, onEditChat, onDeleteChat, onAddReply, onEditReply, onDeleteReply, currentUserId }) {
  const [msg, setMsg] = useState("");
  const [editingId, setEditingId] = useState(null); // id (for main chat) or "msgId:replyId" (for replies)
  const [editMsg, setEditMsg] = useState("");
  const [replyingToId, setReplyingToId] = useState(null);
  const [replyMsg, setReplyMsg] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [company.chat]);

  const send = () => {
    if (!msg.trim()) return;
    onAddChat(company.id, { id: uid(), role: isAdmin ? "강사" : "참여자", senderId: currentUserId, text: msg, createdAt: new Date().toISOString() });
    setMsg("");
  };

  const saveEdit = () => {
    if (!editMsg.trim()) return;
    if (editingId && typeof editingId === "string" && editingId.includes(":")) {
      const [mid, rid] = editingId.split(":");
      onEditReply(company.id, mid, rid, editMsg);
    } else {
      onEditChat(company.id, editingId, editMsg);
    }
    setEditingId(null);
    setEditMsg("");
  };

  const sendReply = (mid) => {
    if (!replyMsg.trim()) return;
    onAddReply(company.id, mid, {
      id: uid(),
      role: isAdmin ? "강사" : "참여자",
      senderId: currentUserId,
      text: replyMsg,
      createdAt: new Date().toISOString(),
    });
    setReplyMsg("");
    setReplyingToId(null);
  };

  // 복사 결과 알림 ("" 이면 표시 안 함)
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const copyText = async (text) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // https 가 아니거나 권한이 없는 환경 대비
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      document.body.removeChild(ta);
    }
    setToast(ok ? "복사되었습니다" : "복사에 실패했습니다");
  };

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-semibold shadow-lg">
          {toast}
        </div>
      )}
      {showReport && isAdmin && <ReportModal company={company} onClose={() => setShowReport(false)} />}
      {showAddParticipant && (
        <AddParticipantModal
          onAdd={(data) => onAddParticipant(company.id, data)}
          onClose={() => setShowAddParticipant(false)}
        />
      )}

      {/* 업체 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-gradient-to-br from-sky-400 to-blue-500 rounded-xl flex items-center justify-center text-white text-xl shadow-sm">🏢</div>
          <div>
            <h2 className="text-base font-bold text-slate-800">{company.name}</h2>
            <p className="text-xs text-slate-400">실습 메인 허브 · 참여자 {company.participants.length}명</p>
            {/* 리포트에 나가는 효과 집계와 같은 숫자를 허브에서도 바로 보이게 한다 */}
            <CompanyEffectSummary participants={company.participants} />
          </div>
        </div>
        {/* 레포트 발행 버튼 — 관리자에게만 표시 */}
        {isAdmin && (
          <button onClick={() => setShowReport(true)}
            className="px-5 py-2.5 bg-gradient-to-r from-indigo-500 to-violet-500 text-white rounded-xl text-sm font-bold hover:opacity-90 transition-opacity flex items-center gap-2 shadow-md">
            📋 레포트 발행
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 참여자 목록 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col h-[500px] lg:h-[600px] overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
            <h3 className="text-sm font-bold text-slate-700">👥 참여자 현황</h3>
            <button onClick={() => setShowAddParticipant(true)}
              className="px-3 py-1.5 bg-sky-50 text-sky-600 rounded-lg text-xs font-bold hover:bg-sky-100 transition-colors flex items-center gap-1">
              👤 참여자 등록
            </button>
          </div>
          <div className="flex-1 pb-4 overflow-y-auto">
            {company.participants.length === 0 ? (
              <p className="px-5 py-20 text-center text-sm text-slate-400">등록된 참여자가 없습니다.</p>
            ) : (
              Object.entries(
                company.participants.reduce((acc, p) => {
                  const dept = p.dept || '소속 없음';
                  if (!acc[dept]) acc[dept] = [];
                  acc[dept].push(p);
                  return acc;
                }, {})
              ).sort(([deptA], [deptB]) => deptA.localeCompare(deptB))
                .map(([dept, members]) => {
                  members.sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <div key={dept} className="mb-2">
                      <div className="px-5 py-2.5 bg-slate-50 border-y border-slate-100 sticky top-0 z-10">
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">{dept} ({members.length})</h4>
                      </div>
                      <div className="divide-y divide-slate-50">
                        {members.map((p) => (
                          <div key={p.id} className="px-5 py-4 hover:bg-slate-50 transition-colors">
                            <div className="flex items-center justify-between mb-2">
                              <div>
                                <span className="font-semibold text-slate-700 text-sm">{p.name}</span>
                                <span className="ml-2 text-xs text-slate-400">{p.dept}</span>
                              </div>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${sBadge(p.status)}`}>
                                {p.status === "정상" ? "🟢" : "⚠️"} {p.status}
                              </span>
                            </div>
                            <PBar v={avgProgress(p)} />
                            <div className="flex items-center justify-between mt-2">
                              <span className="text-xs text-slate-400">{p.tasks.length}개 과제 · {avgProgress(p)}% 완료</span>
                              <button onClick={() => onSelectParticipant(p.id)}
                                className="text-xs text-violet-600 font-semibold hover:underline">상세보기 →</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
            )}
          </div>
        </div>
        {/* 실시간 채팅 */}
        <div className="relative">
          <div className="absolute inset-0 bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 shrink-0">
              <h3 className="text-sm font-bold text-slate-700">💬 실시간 소통 광장</h3>
            </div>
            <div className="flex-1 px-5 py-4 space-y-3 overflow-y-auto min-h-[180px]">
              {company.chat.map((m, i) => {
                const isMine = m.senderId === currentUserId || (!m.senderId && m.role === (isAdmin ? "강사" : "참여자"));
                const canEdit = isAdmin || isMine;

                // Handle older messages lacking senderId or user deleted: fall back to role string "강사" or "참여자" (not "참")
                const senderName = m.role === "강사" ? "강사" : ((m.senderId && company.participants.find(p => p.id === m.senderId)?.name) || "참여자");
                const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : "";

                return (
                  <div key={m.id || i} className={`flex flex-col gap-2 ${m.role === "강사" || m.role === "나" ? "items-end" : "items-start"}`}>
                    <div className={`flex gap-2 ${m.role === "강사" || m.role === "나" ? "flex-row-reverse" : ""}`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                    ${m.role === "강사" ? "bg-violet-100 text-violet-600"
                          : m.role === "참여자" || m.role === "나" ? "bg-sky-100 text-sky-600"
                            : "bg-slate-100 text-slate-500"}`}>
                        {senderName[0]}
                      </div>
                      <div className={`max-w-[85%] flex flex-col gap-0.5 ${m.role === "강사" || m.role === "나" ? "items-end" : "items-start"}`}>
                        {/* 아바타는 성 한 글자만 보여주므로 전체 이름을 따로 표시한다 */}
                        <span className="text-[11px] font-semibold text-slate-500 px-0.5 leading-none mb-0.5">{senderName}</span>
                        {editingId === (m.id || i) ? (
                          <div className="flex flex-col gap-1 items-end w-full">
                            <textarea value={editMsg} onChange={e => setEditMsg(e.target.value)}
                              className="w-full min-w-[200px] px-3 py-2 text-sm bg-white border border-violet-300 rounded-xl outline-none resize-none" rows={2} />
                            <div className="flex gap-1 mt-1">
                              <button onClick={() => setEditingId(null)} className="text-xs px-2 py-1 text-slate-400 hover:text-slate-600 font-semibold">취소</button>
                              <button onClick={saveEdit} className="text-xs px-2 py-1 bg-violet-500 text-white rounded hover:bg-violet-600 font-semibold">저장</button>
                            </div>
                          </div>
                        ) : (
                          <div className={`flex items-end gap-1.5 ${m.role === "강사" || m.role === "나" ? "flex-row-reverse" : "flex-row"}`}>
                            <div className={`group relative px-3 py-2 rounded-2xl text-sm leading-relaxed
                          ${m.role === "강사" || m.role === "나"
                                ? "bg-sky-500 text-white rounded-tr-sm"
                                : "bg-slate-100 text-slate-700 rounded-tl-sm"}`}>
                              {m.text}

                              {/* Hover Actions */}
                              <div className={`absolute -top-3 flex gap-1 bg-white/95 backdrop-blur shadow-sm border border-slate-200 rounded-lg px-2 py-1.5 
                              opacity-0 group-hover:opacity-100 transition-opacity z-10
                              ${m.role === "강사" || m.role === "나" ? "right-3" : "left-3"}`}>
                                <button onClick={() => copyText(m.text)} className="text-[11px] font-bold text-slate-500 hover:text-violet-500 whitespace-nowrap px-1">복사</button>
                                <button onClick={() => { setReplyingToId(m.id || i); setReplyMsg(""); }} className="text-[11px] font-bold text-slate-500 hover:text-emerald-500 whitespace-nowrap px-1 border-l pl-2 ml-1">답글</button>
                                {canEdit && (
                                  <>
                                    <button onClick={() => { setEditingId(m.id || i); setEditMsg(m.text); }} className="text-[11px] font-bold text-slate-500 hover:text-sky-500 whitespace-nowrap px-1 border-l pl-2 ml-1">수정</button>
                                    <button onClick={() => onDeleteChat(company.id, m.id)} className="text-[11px] font-bold text-slate-500 hover:text-rose-500 whitespace-nowrap px-1 border-l pl-2 ml-1">삭제</button>
                                  </>
                                )}
                              </div>
                            </div>
                            {timeStr && <span className="text-[10px] text-slate-400 shrink-0 mb-1">{timeStr}</span>}
                          </div>
                        )}

                        {/* Reply Input Box */}
                        {replyingToId === (m.id || i) && (
                          <div className={`mt-2 flex gap-2 w-full max-w-[300px] ${m.role === "강사" || m.role === "나" ? "justify-end" : "justify-start"}`}>
                            <input value={replyMsg} onChange={(e) => setReplyMsg(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && sendReply(m.id || i)} placeholder="답글 입력..." autoFocus
                              className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 transition-all" />
                            <div className="flex gap-1">
                              <button onClick={sendReply.bind(null, m.id || i)} className="px-2.5 py-1.5 bg-emerald-500 text-white rounded-lg text-xs font-semibold hover:bg-emerald-600 transition-colors">등록</button>
                              <button onClick={() => { setReplyingToId(null); setReplyMsg("") }} className="px-2.5 py-1.5 bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-300 transition-colors">취소</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Replies List */}
                    {m.replies && m.replies.length > 0 && (
                      <div className={`flex flex-col gap-2 mt-1 w-[90%] ${m.role === "강사" || m.role === "나" ? "mr-6 items-end" : "ml-6 items-start"}`}>
                        {m.replies.map((r, ri) => {
                          const rIsMine = r.senderId === currentUserId || (!r.senderId && r.role === (isAdmin ? "강사" : "참여자"));
                          const rCanEdit = isAdmin || rIsMine;
                          const rSenderName = r.role === "강사" ? "강사" : ((r.senderId && company.participants.find(p => p.id === r.senderId)?.name) || "참여자");
                          const rTimeStr = r.createdAt ? new Date(r.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : "";
                          const rEditId = `${m.id || i}:${r.id || ri}`;

                          return (
                            <div key={r.id || ri} className={`flex gap-2 ${r.role === "강사" || r.role === "나" ? "flex-row-reverse" : ""}`}>
                              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0
                                ${r.role === "강사" ? "bg-violet-100 text-violet-600" : r.role === "참여자" || r.role === "나" ? "bg-sky-100 text-sky-600" : "bg-slate-100 text-slate-500"}`}>
                                {rSenderName[0]}
                              </div>
                              <div className={`max-w-[85%] flex flex-col gap-0.5 ${r.role === "강사" || r.role === "나" ? "items-end" : "items-start"}`}>
                                <span className="text-[10px] font-semibold text-slate-400 px-0.5 leading-none">{rSenderName}</span>
                                {editingId === rEditId ? (
                                  <div className="flex flex-col gap-1 items-end w-full">
                                    <textarea value={editMsg} onChange={e => setEditMsg(e.target.value)}
                                      className="w-full min-w-[180px] px-3 py-2 text-xs bg-white border border-violet-300 rounded-lg outline-none resize-none" rows={2} />
                                    <div className="flex gap-1 mt-1">
                                      <button onClick={() => setEditingId(null)} className="text-[10px] px-2 py-1 text-slate-400 hover:text-slate-600 font-semibold">취소</button>
                                      <button onClick={saveEdit} className="text-[10px] px-2 py-1 bg-violet-500 text-white rounded hover:bg-violet-600 font-semibold">저장</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className={`flex items-end gap-1.5 ${r.role === "강사" || r.role === "나" ? "flex-row-reverse" : "flex-row"}`}>
                                    <div className={`group relative px-2.5 py-1.5 rounded-xl text-xs leading-relaxed
                                  ${r.role === "강사" || r.role === "나" ? "bg-indigo-100 text-indigo-900 rounded-tr-sm" : "bg-slate-100 text-slate-700 rounded-tl-sm"}`}>
                                      {r.text}
                                      {/* 복사는 누구나, 수정·삭제는 본인/관리자만 */}
                                      <div className={`absolute -top-3 flex gap-1 bg-white/95 backdrop-blur shadow-sm border border-slate-200 rounded-md px-1.5 py-1
                                        opacity-0 group-hover:opacity-100 transition-opacity z-10
                                        ${r.role === "강사" || r.role === "나" ? "right-2" : "left-2"}`}>
                                        <button onClick={() => copyText(r.text)} className="text-[10px] font-bold text-slate-500 hover:text-violet-500 whitespace-nowrap px-1">복사</button>
                                        {rCanEdit && (
                                          <>
                                            <button onClick={() => { setEditingId(rEditId); setEditMsg(r.text); }} className="text-[10px] font-bold text-slate-500 hover:text-sky-500 whitespace-nowrap px-1 border-l pl-1 ml-1">수정</button>
                                            <button onClick={() => onDeleteReply(company.id, m.id, r.id)} className="text-[10px] font-bold text-slate-500 hover:text-rose-500 whitespace-nowrap px-1 border-l pl-1 ml-1">삭제</button>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                    {rTimeStr && <span className="text-[9px] text-slate-400 shrink-0 mb-0.5">{rTimeStr}</span>}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              <div ref={chatEndRef} />
            </div>
            <div className="px-4 py-3 border-t border-slate-100 flex gap-2">
              <input value={msg} onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()} placeholder="메시지 입력..."
                className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 transition-all" />
              <button onClick={send}
                className="px-4 py-2 bg-violet-500 text-white rounded-xl text-sm font-semibold hover:bg-violet-600 transition-colors">
                전송
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   TAB 3 — 개인 대시보드 (관리자 + 참여자 통합)
═══════════════════════════════════════════════════ */
function PersonalDashboard({ participant, companyName, schedule, isAdmin, isMine, onUpdate, onAddTask, onDeleteTask }) {
  const [showAddTask, setShowAddTask] = useState(false);
  const [editSummary, setEditSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(participant.summary);
  const [planDraft, setPlanDraft] = useState(participant.nextWeekPlan || "");
  const [memoDraft, setMemoDraft] = useState(participant.instructorMemo);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [taskNameDraft, setTaskNameDraft] = useState("");

  const updateProgress = (tid, val) =>
    onUpdate({ ...participant, tasks: participant.tasks.map((t) => t.id === tid ? { ...t, progress: Number(val) } : t) });

  const [taskMetaDraft, setTaskMetaDraft] = useState(emptyTaskMeta);

  const startEditTask = (t) => {
    setEditingTaskId(t.id);
    setTaskNameDraft(t.name);
    setTaskMetaDraft({
      scope: t.scope || "",
      headcount: t.headcount || "",
      effectType: t.effectType || "",
      effectValue: t.effectValue || "",
    });
  };
  const cancelEditTask = () => { setEditingTaskId(null); setTaskNameDraft(""); setTaskMetaDraft(emptyTaskMeta()); };
  const saveTaskName = (tid) => {
    const name = taskNameDraft.trim();
    if (!name) return;                       // 빈 이름으로는 저장하지 않는다
    const meta = normalizeTaskMeta(taskMetaDraft);
    onUpdate({
      ...participant,
      tasks: participant.tasks.map((t) => t.id === tid ? { ...t, name, ...meta } : t),
    });
    cancelEditTask();
  };
  const saveSummary = () => { onUpdate({ ...participant, summary: summaryDraft, nextWeekPlan: planDraft }); setEditSummary(false); };
  const saveMemo = () => onUpdate({ ...participant, instructorMemo: memoDraft });
  const saveStatus = (s) => onUpdate({ ...participant, status: s });

  // ── 일정 계산 ──────────────────────────────────────────────
  const sc = schedule || {};
  const hasSchedule = sc.startDate && sc.endDate;
  let targetPct = 0;
  let schedStatus = "미설정";
  let schedStatusColor = "text-slate-400";
  let schedStatusBg = "bg-slate-50 border-slate-200";
  const actualPct = avgProgress(participant);

  if (hasSchedule) {
    const today = new Date();
    const start = new Date(sc.startDate);
    const end = new Date(sc.endDate);
    const totalMs = end - start;
    const elapsedMs = today - start;
    targetPct = Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));
    const diff = actualPct - targetPct;
    if (diff >= 0) {
      schedStatus = "양호"; schedStatusColor = "text-emerald-700"; schedStatusBg = "bg-emerald-50 border-emerald-200";
    } else if (diff >= -15) {
      schedStatus = "정상"; schedStatusColor = "text-amber-700"; schedStatusBg = "bg-amber-50 border-amber-200";
    } else {
      schedStatus = "정체"; schedStatusColor = "text-rose-700"; schedStatusBg = "bg-rose-50 border-rose-200";
    }
  }

  return (
    <div className="space-y-4">
      {showAddTask && (
        <AddTaskModal onAdd={(name, meta) => onAddTask(participant.id, name, meta)} onClose={() => setShowAddTask(false)} />
      )}

      {/* 헤더 카드 */}
      <div className="bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 rounded-2xl p-5 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-md">
        <div>
          <div className="text-xs opacity-70 mb-0.5">{companyName} · {participant.dept}</div>
          <div className="text-2xl font-extrabold">{participant.name}</div>
          <div className="text-xs opacity-60 mt-1">{participant.email}</div>
        </div>
        <div className="flex sm:block items-end justify-between w-full sm:w-auto text-left sm:text-right">
          <div>
            <div className="text-5xl font-black">{actualPct}%</div>
            <div className="text-xs opacity-70">전체 진척도</div>
          </div>
          {isMine ? (
            <select value={participant.status} onChange={(e) => saveStatus(e.target.value)}
              className="mt-2 sm:mt-2 px-3 py-1 bg-white/20 text-white text-xs font-semibold rounded-full border border-white/30 outline-none cursor-pointer backdrop-blur">
              <option value="정상" className="text-slate-800">🟢 정상 진행</option>
              <option value="정체" className="text-slate-800">⚠️ 실적 정체</option>
            </select>
          ) : (
            <div className="mt-2 sm:mt-2 px-3 py-1 bg-white/20 text-white text-xs font-semibold rounded-full border border-white/30 inline-block backdrop-blur">
              {participant.status === "정상" ? "🟢 정상 진행" : "⚠️ 실적 정체"}
            </div>
          )}
        </div>
      </div>

      {/* 📅 프로젝트 일정 vs 실적 카드 */}
      {hasSchedule ? (
        <div className={`rounded-2xl border p-5 ${schedStatusBg}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-700">📅 프로젝트 일정 대비 실적</h3>
            <span className={`px-3 py-1 rounded-full text-xs font-extrabold border ${schedStatusBg} ${schedStatusColor}`}>
              {schedStatus === "양호" ? "🟢" : schedStatus === "정상" ? "🟡" : "🔴"} {schedStatus}
            </span>
          </div>
          {/* 타임라인 마일스톤 */}
          <div className="flex items-center gap-1 mb-4 text-xs overflow-x-auto whitespace-nowrap" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <span className="text-emerald-600 font-semibold">🚀 {sc.startDate}</span>
            <div className="flex-1 border-t-2 border-dashed border-slate-200 mx-2 min-w-[20px]" />
            {sc.kickoffDate && <><span className="text-amber-600 font-semibold">🎯 {sc.kickoffDate}</span><div className="flex-1 border-t-2 border-dashed border-slate-200 mx-2 min-w-[20px]" /></>}
            <span className="text-rose-600 font-semibold">🏁 {sc.endDate}</span>
          </div>
          {/* 목표 진척도 바 */}
          <div className="space-y-2.5">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-500 font-semibold">⏱ 목표 달성률 (경과일 기준)</span>
                <span className="font-extrabold text-slate-700">{targetPct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                <div className="h-3 rounded-full bg-gradient-to-r from-slate-300 to-slate-400 transition-all duration-700"
                  style={{ width: `${targetPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className={`font-semibold ${schedStatusColor}`}>📊 실제 진척도 (참여자 입력)</span>
                <span className={`font-extrabold ${schedStatusColor}`}>{actualPct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                <div className={`h-3 rounded-full transition-all duration-700 ${schedStatus === "양호" ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
                  : schedStatus === "정상" ? "bg-gradient-to-r from-amber-400 to-amber-500"
                    : "bg-gradient-to-r from-rose-400 to-rose-500"}`}
                  style={{ width: `${actualPct}%` }} />
              </div>
            </div>
            <p className="text-xs text-slate-500 text-center pt-1">
              {schedStatus === "양호" && `목표 대비 ${actualPct - targetPct}% 앞서 있습니다 👍`}
              {schedStatus === "정상" && `목표 대비 ${targetPct - actualPct}% 이내 — 정상 범위입니다`}
              {schedStatus === "정체" && `목표 대비 ${targetPct - actualPct}% 뒤처져 있습니다 ⚠️`}
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-slate-50 border border-dashed border-slate-200 rounded-2xl p-5 text-center">
          <p className="text-sm text-slate-400">📅 강사가 아직 프로젝트 일정을 등록하지 않았습니다.</p>
        </div>
      )}

      {/* 과제 목록 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">🛠️ 과제 현황</h3>
          {isMine && (
            <button onClick={() => setShowAddTask(true)}
              className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-bold hover:bg-emerald-100 transition-colors">
              ➕ 과제 추가
            </button>
          )}
        </div>
        {participant.tasks.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-400">등록된 과제가 없습니다.</p>
        ) : (
          <div className="divide-y divide-slate-50">
            {participant.tasks.map((t) => (
              <div key={t.id} className="px-5 py-4">
                {editingTaskId === t.id ? (
                  <div className="mb-2 bg-violet-50/40 border border-violet-100 rounded-xl p-3 space-y-2">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">과제명</label>
                      <input autoFocus value={taskNameDraft}
                        onChange={(e) => setTaskNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveTaskName(t.id);
                          if (e.key === "Escape") cancelEditTask();
                        }}
                        className="w-full px-3 py-1.5 text-sm bg-white border border-violet-300 rounded-lg outline-none focus:ring-2 focus:ring-violet-100" />
                    </div>
                    <TaskMetaFields value={taskMetaDraft} onChange={setTaskMetaDraft} compact />
                    <div className="flex gap-2 justify-end pt-1">
                      <button onClick={cancelEditTask}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors">
                        취소
                      </button>
                      <button onClick={() => saveTaskName(t.id)} disabled={!taskNameDraft.trim()}
                        className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-colors ${taskNameDraft.trim() ? "bg-violet-500 text-white hover:bg-violet-600" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}>
                        저장
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <span className="font-semibold text-slate-700 text-sm min-w-0 truncate">🔗 {t.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <DeltaEl d={t.delta} />
                      <span className="text-sm font-bold text-slate-700 w-8 text-right">{t.progress}%</span>
                      {isMine && (
                        <>
                          <button onClick={() => startEditTask(t)}
                            className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-violet-500 hover:bg-violet-50 rounded-lg transition-colors"
                            title="과제명 수정">✏️</button>
                          <button onClick={() => onDeleteTask(participant.id, t.id)}
                            className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-rose-400 hover:bg-rose-50 rounded-lg transition-colors"
                            title="과제 삭제">×</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {editingTaskId !== t.id && <TaskMetaChips task={t} />}
                <PBar v={t.progress} />
                {isMine && (
                  <input type="range" min={0} max={100} value={t.progress}
                    onChange={(e) => updateProgress(t.id, e.target.value)}
                    className="w-full mt-2.5 accent-violet-500 cursor-pointer" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 금주 요약 보고 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">📝 금주 요약 및 차주 계획</h3>
          {isMine && (
            <button onClick={() => { setSummaryDraft(participant.summary); setPlanDraft(participant.nextWeekPlan || ""); setEditSummary(!editSummary); }}
              className="text-xs text-violet-500 font-semibold hover:underline">
              {editSummary ? "취소" : "✏️ 수정"}
            </button>
          )}
        </div>
        <div className="px-5 py-4">
          {editSummary ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">금주 요약</label>
                <textarea value={summaryDraft} onChange={(e) => setSummaryDraft(e.target.value)} rows={3}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 resize-none transition-all" />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">차주 계획</label>
                <textarea value={planDraft} onChange={(e) => setPlanDraft(e.target.value)} rows={3}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 resize-none transition-all" />
              </div>
              <div className="flex justify-end">
                <button onClick={saveSummary}
                  className="px-5 py-2 bg-emerald-500 text-white rounded-xl text-sm font-semibold hover:bg-emerald-600 transition-colors">
                  저장
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <span className="text-xs font-semibold text-slate-400 block mb-1.5">금주 요약</span>
                <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-3">{participant.summary || "내용이 없습니다."}</p>
              </div>
              <div>
                <span className="text-xs font-semibold text-slate-400 block mb-1.5">차주 계획</span>
                <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-3">{participant.nextWeekPlan || "내용이 없습니다."}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 강사 피드백 — 관리자만 편집 가능, 참여자는 읽기 전용 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">✏️ 강사 피드백 메모</h3>
          {isAdmin && <span className="text-xs bg-violet-50 text-violet-500 px-2 py-0.5 rounded-full">관리자 편집</span>}
        </div>
        <div className="px-5 py-4">
          {isAdmin ? (
            <div className="flex gap-3">
              <input value={memoDraft} onChange={(e) => setMemoDraft(e.target.value)}
                className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 transition-all" />
              <button onClick={saveMemo}
                className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-semibold hover:bg-emerald-600 transition-colors">
                저장
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-600 bg-slate-50 rounded-xl p-3">{participant.instructorMemo || "—"}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   메인 APP
═══════════════════════════════════════════════════ */
export default function App() {
  const [companies, setCompanies] = useState([]);
  const companiesRef = useRef(companies);
  useEffect(() => { companiesRef.current = companies; }, [companies]);

  // "loading" 최초 로딩 | "synced" 서버 확정 | "offline" 캐시만 | "missing" 서버에 문서 없음 | "error"
  const [dbStatus, setDbStatus] = useState("loading");
  const [alertMsg, setAlertMsg] = useState("");
  const [authState, setAuthState] = useState(null);

  const [adminAuth, setAdminAuth] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  const isServerSynced = dbStatus === "synced";
  const isServerSyncedRef = useRef(false);
  useEffect(() => { isServerSyncedRef.current = isServerSynced; }, [isServerSynced]);

  useEffect(() => {
    const ref = doc(db, ...DATA_DOC);
    // includeMetadataChanges 필수: 캐시로 먼저 뜬 뒤 서버가 같은 내용을 확인해 주면
    // 데이터는 그대로고 fromCache만 false로 바뀐다. 이 옵션이 없으면 그 전환이
    // 이벤트로 오지 않아 영원히 "오프라인"으로 남고 저장이 전부 막힌다.
    const unsub = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        const fromCache = snap.metadata.fromCache;
        if (snap.exists()) {
          const data = snap.data().companies;
          if (Array.isArray(data)) setCompanies(data);
          setDbStatus(fromCache ? "offline" : "synced");
          if (!fromCache) setAlertMsg("");
        } else {
          // ⛔ 여기서 절대 시드 데이터를 쓰지 않는다.
          // 오프라인 상태에서는 캐시가 비어 있다는 이유만으로 "문서 없음"이 올라온다.
          // 2026-09-07, 이 자리에서 INIT을 써버려 운영 데이터 전체가 소실되었다.
          setDbStatus(fromCache ? "offline" : "missing");
        }
      },
      (err) => {
        // 기존 코드에는 에러 콜백이 없어 권한·할당량·네트워크 오류가 전부 무음이었다.
        console.error("[firestore:onSnapshot]", err);
        setDbStatus("error");
        setAlertMsg(`서버 연결 오류: ${err.message}`);
      }
    );
    return () => unsub();
  }, []);

  // 관리자 비밀번호 해시 (companies와 별도 문서)
  useEffect(() => {
    getDoc(doc(db, ...CONFIG_DOC))
      .then((snap) => {
        const d = snap.exists() ? snap.data() : null;
        setAdminAuth(d?.adminPasswordHash
          ? { hash: d.adminPasswordHash, salt: d.adminPasswordSalt, iterations: d.adminPasswordIterations }
          : null);
      })
      .catch((err) => { console.error("[firestore:config]", err); setAdminAuth(null); })
      .finally(() => setConfigLoaded(true));
  }, []);

  // 모든 저장은 트랜잭션으로 "서버 최신본" 위에 다시 계산한다.
  // 로컬 사본을 통째로 덮어쓰던 기존 방식은 동시 사용 시 서로의 변경을 지웠다.
  // 반환값: { ok: boolean, error?: Error }
  const updateCompanies = (updater, opts = {}) => {
    const apply = (base) => (typeof updater === "function" ? updater(base) : updater);
    const rollback = companiesRef.current;

    setCompanies(apply(rollback)); // 낙관적 UI

    if (!isServerSyncedRef.current) {
      setCompanies(rollback);
      setAlertMsg("서버와 동기화되지 않아 저장할 수 없습니다. 네트워크를 확인하고 새로고침해 주세요. (변경사항은 저장되지 않았습니다)");
      return Promise.resolve({ ok: false, error: new Error("NOT_SYNCED") });
    }

    return runTransaction(db, async (tx) => {
      const ref = doc(db, ...DATA_DOC);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("대시보드 문서를 찾을 수 없습니다. 저장을 중단했습니다.");

      const server = snap.data().companies;
      if (!Array.isArray(server)) throw new Error("서버 데이터 형식이 올바르지 않아 저장을 중단했습니다.");

      const next = apply(server);
      if (!Array.isArray(next)) throw new Error("저장할 데이터 형식이 올바르지 않습니다.");

      // 대량 소실 가드 — 명시적 삭제가 아닌데 수가 줄면 쓰지 않는다.
      if (!opts.allowShrink) {
        const before = countParticipants(server);
        const after = countParticipants(next);
        if (after < before || next.length < server.length) {
          throw new Error(
            `데이터가 줄어드는 저장이 차단되었습니다 (참여자 ${before}→${after}, 업체 ${server.length}→${next.length}). 화면을 새로고침해 주세요.`
          );
        }
      }

      tx.set(ref, { companies: next });
      return next;
    })
      .then((next) => {
        setCompanies(next);
        setAlertMsg("");
        return { ok: true };
      })
      .catch((err) => {
        console.error("[firestore:write]", err);
        setCompanies(rollback); // 낙관적 갱신 되돌리기
        setAlertMsg(err.message || "저장에 실패했습니다.");
        return { ok: false, error: err };
      });
  };

  // null                              = 미로그인 → 로그인 화면
  // {role: 'admin' }                = 관리자
  // {role: 'participant', id: '' }   = 참여자
  const isAdmin = authState?.role === 'admin';
  const myParticipantId = authState?.role === 'participant' ? authState.id : null;

  const [tab, setTab] = useState("company");
  const [companyId, setCompanyId] = useState(() => {
    try { return localStorage.getItem("ai-dashboard-cid") || ""; } catch { return ""; }
  });
  const [participantId, setParticipantId] = useState(null);

  // 참여자는 소속 업체를 바꿀 수 없다(업체 칩도 관리자만 눌린다).
  // 그러니 companyId 상태를 거치지 말고 본인 소속에서 곧바로 파생한다.
  // 예전에는 로그인 시점에 setCompanyId 로 맞춰줬는데, 신규 등록 직후에는
  // handleLogin 이 등록 이전의 companies 를 붙들고 있어 본인 업체를 못 찾았고,
  // 그대로 companies[0](파워넷사) 허브가 열렸다.
  const myCompany = myParticipantId
    ? companies.find((c) => c.participants.some((p) => p.id === myParticipantId)) : null;

  // 관리자용: 저장된 업체 id가 비었거나 더 이상 없으면 첫 업체로 떨어진다.
  const adminSelectedCompany = companies.find((c) => c.id === companyId) || companies[0];
  const selectedCompany = myParticipantId ? myCompany : adminSelectedCompany;
  const effectiveCompanyId = selectedCompany?.id || "";

  useEffect(() => {
    if (effectiveCompanyId) localStorage.setItem("ai-dashboard-cid", effectiveCompanyId);
  }, [effectiveCompanyId]);

  const allParticipants = companies.flatMap((c) => c.participants.map((p) => ({ ...p, companyName: c.name })));
  const selectedParticipant = participantId ? allParticipants.find((p) => p.id === participantId) : null;
  const selectedParticipantCompany = participantId
    ? companies.find((c) => c.participants.some((p) => p.id === participantId))?.name || "" : "";

  // updater는 트랜잭션 재시도 때 여러 번 실행되므로 uid()는 반드시 바깥에서 만든다.
  const addCompany = (name) => {
    const id = uid();
    return updateCompanies((prev) => [...prev, { id, name, participants: [], chat: [] }]);
  };

  const addParticipant = (cid, { id, name, dept, email }) => {
    const newId = id || uid();
    return updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : {
        ...c,
        participants: [...c.participants, {
          id: newId, name, dept, email: email || "", status: "정상",
          tasks: [], summary: "", nextWeekPlan: "", instructorMemo: "",
        }],
      }
    ));
  };

  const deleteCompany = (cid) => {
    const target = companies.find((c) => c.id === cid);
    const hadParticipant = target?.participants.some((p) => p.id === participantId);
    // 화면 상태 변경은 updater 밖에서. updater는 트랜잭션 재시도로 여러 번 실행된다.
    const remaining = companies.filter((c) => c.id !== cid);
    if (effectiveCompanyId === cid && remaining.length > 0) setCompanyId(remaining[0].id);
    if (hadParticipant) setParticipantId(null);
    return updateCompanies(
      (prev) => prev.filter((c) => c.id !== cid),
      { allowShrink: true }
    );
  };

  const deleteParticipant = (cid, pid) => {
    // 마지막 참여자를 지울 때 업체까지 통째로 지우던 동작을 제거했다.
    // 참여자 1명 삭제가 업체·채팅·일정 전체 삭제로 번지는 사고 경로였다.
    if (participantId === pid) setParticipantId(null);
    return updateCompanies(
      (prev) => prev.map((c) =>
        c.id !== cid ? c : { ...c, participants: c.participants.filter((p) => p.id !== pid) }
      ),
      { allowShrink: true }
    );
  };

  const updateParticipant = (updated) =>
    updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) => p.id === updated.id ? updated : p),
    })));

  const addTask = (pid, name, meta) => {
    const tid = uid();
    const extra = meta || normalizeTaskMeta(emptyTaskMeta());
    return updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) =>
        p.id === pid ? { ...p, tasks: [...p.tasks, { id: tid, name, progress: 0, delta: 0, ...extra }] } : p),
    })));
  };

  const deleteTask = (pid, tid) =>
    updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) =>
        p.id === pid ? { ...p, tasks: p.tasks.filter((t) => t.id !== tid) } : p),
    })));

  const updateCompanySchedule = (cid, sched) =>
    updateCompanies((prev) => prev.map((c) => c.id !== cid ? c : { ...c, schedule: sched }));

  const addChat = (cid, message) => {
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: [...c.chat, { ...message, replies: [] }] }
    ));
  };

  const editChat = (cid, mid, newText) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: c.chat.map(m => m.id === mid ? { ...m, text: newText } : m) }
    ));

  const deleteChat = (cid, mid) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: c.chat.filter(m => m.id !== mid) }
    ));

  const addReply = (cid, mid, replyMsg) => {
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : {
        ...c, chat: c.chat.map(m => m.id === mid ? { ...m, replies: [...(m.replies || []), replyMsg] } : m)
      }
    ));
  };

  const editReply = (cid, mid, rid, newText) => {
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : {
        ...c, chat: c.chat.map(m => m.id === mid ? {
          ...m, replies: (m.replies || []).map(r => r.id === rid ? { ...r, text: newText } : r)
        } : m)
      }
    ));
  };

  const onDeleteReply = (cid, mid, rid) => {
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : {
        ...c, chat: c.chat.map(m => m.id === mid ? {
          ...m, replies: (m.replies || []).filter(r => r.id !== rid)
        } : m)
      }
    ));
  };

  const goToParticipant = (pid) => { setParticipantId(pid); setTab("personal"); };
  const goToCompany = (cid) => { setCompanyId(cid); setTab("company"); };

  /* ─── 계정 백업 / 복구 ─────────────────────────── */
  const [showBackup, setShowBackup] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // 관리자가 볼 때마다 명단 스냅샷을 이 브라우저에 남긴다. 수동 백업을 잊어도 되돌릴 수단이 생긴다.
  useEffect(() => {
    if (isAdmin && isServerSynced) writeLocalSnapshot(companies);
  }, [isAdmin, isServerSynced, companies]);

  // 복구는 '추가만' 한다. 기존 참여자의 과제·요약·메모는 절대 건드리지 않는다.
  const restoreRoster = async (backup) => {
    // uid()는 updater 밖에서 미리 확정한다(트랜잭션 재시도 대비).
    const prepared = backup.companies.map((bc) => ({
      id: bc.id || uid(),
      name: bc.name,
      schedule: bc.schedule || null,
      participants: (bc.participants || []).map((bp) => ({
        id: bp.id || uid(),
        name: bp.name,
        dept: bp.dept || "",
        email: bp.email || "",
      })),
    }));

    const res = await updateCompanies((prev) => {
      const next = prev.map((c) => ({ ...c, participants: [...(c.participants || [])] }));
      for (const bc of prepared) {
        let target = next.find((c) => c.id === bc.id) || next.find((c) => c.name === bc.name);
        if (!target) {
          target = {
            id: bc.id, name: bc.name, participants: [], chat: [],
            ...(bc.schedule ? { schedule: bc.schedule } : {}),
          };
          next.push(target);
        }
        for (const bp of bc.participants) {
          const dup = target.participants.some(
            (p) => p.id === bp.id || (p.name === bp.name && p.email === bp.email)
          );
          if (dup) continue;
          target.participants.push({
            id: bp.id, name: bp.name, dept: bp.dept, email: bp.email,
            status: "정상", tasks: [], summary: "", nextWeekPlan: "", instructorMemo: "",
          });
        }
      }
      return next;
    });

    if (!res.ok) throw res.error || new Error("복구에 실패했습니다.");
  };

  // 참여자 본인 정보 파생 (myCompany 는 selectedCompany 계산에 필요해 위에서 이미 구했다)
  const myParticipant = myParticipantId ? allParticipants.find((p) => p.id === myParticipantId) : null;

  // 로그인
  const handleLogin = (auth) => {
    setAuthState(auth);
    if (auth.role === 'admin') {
      setTab("instructor");
      // 기본 비밀번호로 들어온 경우 즉시 변경을 유도한다.
      if (auth.needsPasswordSetup) setShowPassword(true);
    } else {
      setParticipantId(auth.id);
      // 소속 업체는 selectedCompany 가 본인 기준으로 파생하므로 여기서 맞출 필요가 없다.
      // 로그아웃 후 관리자로 들어올 때를 위해 companyId 만 참고용으로 갱신한다.
      // companies 상태 대신 ref 를 쓴다. 신규 등록 직후에는 이 클로저의 companies 가
      // 아직 방금 등록한 참여자를 담고 있지 않다.
      const cid = auth.cid || companiesRef.current.find(
        (co) => co.participants.some((p) => p.id === auth.id)
      )?.id;
      if (cid) setCompanyId(cid);
      setTab("company");
    }
  };

  // 로그아웃 → 로그인 화면
  const handleLogout = () => {
    setAuthState(null);
    setTab("company");
    setParticipantId(null);
  };

  const tabs = [
    ...(isAdmin ? [{ id: "instructor", label: "🎖️ 강사 관제 센터" }] : []),
    { id: "company", label: "🏢 업체 허브" },
    { id: "personal", label: "👤 개인 대시보드" },
  ];

  if (dbStatus === "loading" || !configLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-violet-500 font-bold animate-pulse text-lg tracking-wide">
          데이터베이스 동기화 중...
        </div>
      </div>
    );
  }

  // 서버에 문서가 없다고 응답한 경우. 예전에는 여기서 시드 데이터를 써버려 전체가 날아갔다.
  // 이제는 아무것도 쓰지 않고 멈춘다.
  if (dbStatus === "missing") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white rounded-2xl shadow-sm border border-rose-100 max-w-md w-full p-8 text-center space-y-3">
          <div className="text-4xl">🚫</div>
          <h1 className="text-base font-bold text-slate-800">대시보드 데이터를 찾을 수 없습니다</h1>
          <p className="text-sm text-slate-500 leading-relaxed">
            서버에 <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">dashboard/data</code> 문서가 없습니다.
            데이터 보호를 위해 자동 생성하지 않습니다. 관리자에게 문의해 주세요.
          </p>
          <button onClick={() => window.location.reload()}
            className="px-5 py-2 text-sm bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition-colors font-semibold">
            새로고침
          </button>
        </div>
      </div>
    );
  }

  const statusBanner = dbStatus !== "synced" || alertMsg ? (
    <div className={`px-4 py-2.5 text-xs font-bold text-center ${dbStatus === "synced" ? "bg-rose-50 text-rose-700 border-b border-rose-100" : "bg-amber-50 text-amber-800 border-b border-amber-200"}`}>
      {alertMsg || (dbStatus === "offline"
        ? "⚠️ 오프라인 상태입니다. 화면은 마지막으로 받은 내용이며, 변경사항은 저장되지 않습니다."
        : "⚠️ 서버와 연결되지 않았습니다. 변경사항은 저장되지 않습니다.")}
    </div>
  ) : null;

  if (!authState) {
    return (
      <>
        {statusBanner}
        <LoginScreen companies={companies} onLogin={handleLogin} onRegister={addParticipant}
          adminAuth={adminAuth} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/30 to-sky-50/40">
      {showBackup && (
        <BackupRestoreModal companies={companies} onRestore={restoreRoster}
          onClose={() => setShowBackup(false)} />
      )}
      {showPassword && (
        <AdminPasswordModal adminAuth={adminAuth}
          onSaved={setAdminAuth} onClose={() => setShowPassword(false)} />
      )}
      {statusBanner}
      {/* 헤더 */}
      <header className="bg-white/80 backdrop-blur-md border-b border-slate-100 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl flex items-center justify-center text-white font-extrabold text-sm shadow-sm">AI</div>
            <div>
              <h1 className="text-sm font-extrabold text-slate-800 leading-tight">AI 실습 프로젝트</h1>
              <p className="text-xs text-slate-400">통합 스마트 대시보드</p>
            </div>
          </div>
          {/* 모드 전환 토글 (현재 인증 상태 표시 및 로그아웃) */}
          <div className="flex items-center gap-3">
            {isAdmin ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-violet-50 border border-violet-200 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-violet-500" />
                  <span className="text-xs font-bold text-violet-700">🔑 관리자</span>
                </div>
                <button onClick={handleLogout}
                  className="px-3 py-1.5 rounded-full text-xs font-bold border bg-white text-slate-500 border-slate-200 hover:border-rose-300 hover:text-rose-500 transition-all">
                  로그아웃
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-sky-50 border border-sky-200 rounded-full">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  <span className="text-xs font-bold text-sky-700">👤 {myParticipant?.name}</span>
                  <span className="text-xs text-sky-500 opacity-70">({myCompany?.name})</span>
                </div>
                <button onClick={handleLogout}
                  className="px-3 py-1.5 rounded-full text-xs font-bold border bg-white text-slate-500 border-slate-200 hover:border-rose-300 hover:text-rose-500 transition-all">
                  로그아웃
                </button>
              </div>
            )}
            <span className="text-xs text-slate-400">{new Date().toLocaleDateString("ko-KR")}</span>
          </div>
        </div>
        {/* 탭 */}
        <div className="max-w-6xl mx-auto px-6 flex gap-0.5 overflow-x-auto whitespace-nowrap" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-semibold rounded-t-xl transition-all border-b-2
                ${tab === t.id
                  ? "text-violet-600 border-violet-500 bg-violet-50"
                  : "text-slate-400 border-transparent hover:text-slate-600 hover:bg-slate-50"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {/* 업체 선택 칩 — 참여자 모드면 본인 업체만 */}
        {tab === "company" && (
          <div className="flex gap-2 mb-5 flex-wrap">
            {(isAdmin ? companies : (myCompany ? [myCompany] : [])).map((c) => (
              <button key={c.id} onClick={() => isAdmin && setCompanyId(c.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
                  ${effectiveCompanyId === c.id ? "bg-sky-500 text-white shadow-sm" : "bg-white text-slate-500 border border-slate-200 hover:border-sky-300"}
                  ${!isAdmin ? "cursor-default" : ""}`}>
                {c.name}
              </button>
            ))}
          </div>
        )}

        {/* 참여자 선택 칩 — 참여자 모드면 본인 업체 구성원 모두 표시 */}
        {tab === "personal" && (
          <div className="flex gap-2 mb-5 flex-wrap">
            {(isAdmin ? allParticipants : (myCompany ? myCompany.participants.map(p => ({ ...p, companyName: myCompany.name })) : [])).map((p) => (
              <button key={p.id} onClick={() => setParticipantId(p.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
                  ${participantId === p.id ? "bg-violet-500 text-white shadow-sm" : "bg-white text-slate-500 border border-slate-200 hover:border-violet-300 hover:bg-violet-50"}`}>
                {p.name}<span className="opacity-60 text-xs ml-1">({p.companyName})</span>
              </button>
            ))}
          </div>
        )}

        {/* 탭 콘텐츠 */}
        {tab === "instructor" && isAdmin && (
          <InstructorView companies={companies} onSelectCompany={goToCompany}
            onSelectParticipant={goToParticipant} onAddCompany={addCompany}
            onDeleteCompany={deleteCompany} onDeleteParticipant={deleteParticipant}
            onUpdateSchedule={updateCompanySchedule}
            onOpenBackup={() => setShowBackup(true)}
            onOpenPassword={() => setShowPassword(true)} />
        )}

        {tab === "company" && selectedCompany && (
          <CompanyHub key={selectedCompany.id} company={selectedCompany}
            isAdmin={isAdmin} onSelectParticipant={goToParticipant}
            onAddParticipant={addParticipant} onAddChat={addChat}
            onEditChat={editChat} onDeleteChat={deleteChat}
            onAddReply={addReply} onEditReply={editReply} onDeleteReply={onDeleteReply}
            currentUserId={isAdmin ? "admin" : myParticipantId} />
        )}
        {tab === "company" && !selectedCompany && (
          <div className="text-center py-24 text-slate-400">
            <div className="text-5xl mb-3">🏢</div>
            <p className="text-sm font-medium">업체를 선택해 주세요</p>
          </div>
        )}

        {tab === "personal" && selectedParticipant && (
          <PersonalDashboard key={selectedParticipant.id} participant={selectedParticipant}
            companyName={selectedParticipantCompany} isAdmin={isAdmin}
            isMine={isAdmin || myParticipantId === selectedParticipant.id}
            schedule={companies.find((c) => c.participants.some((p) => p.id === selectedParticipant.id))?.schedule}
            onUpdate={updateParticipant} onAddTask={addTask} onDeleteTask={deleteTask} />
        )}
        {tab === "personal" && !selectedParticipant && (
          <div className="text-center py-24 text-slate-400">
            <div className="text-5xl mb-3">👆</div>
            <p className="text-sm font-medium">위에서 참여자를 선택해 주세요</p>
          </div>
        )}
      </main>
    </div>
  );
}
