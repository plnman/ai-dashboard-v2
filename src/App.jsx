import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { doc, setDoc, onSnapshot } from "firebase/firestore";

/* ═══════════════════════════════════════════════════
   초기 데이터
═══════════════════════════════════════════════════ */
const uid = () => "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 8);

const INIT = [
  {
    id: "c1",
    name: "파워넷사",
    participants: [
      {
        id: "p1", name: "김철수", email: "ks@powernet.com", dept: "DX 추진팀", status: "정상",
        tasks: [
          { id: "t1", name: "딥러닝 경량화", progress: 75, delta: 10 },
          { id: "t2", name: "비전 검사 자동화", progress: 80, delta: 5 },
        ],
        summary: "양자화 기법을 적용하여 정확도 손실을 2% 이내로 방어하며 추론 속도를 개선했습니다.",
        nextWeekPlan: "엣지 디바이스 환경 최적화 테스트를 진행할 예정입니다.",
        instructorMemo: "기법 적용이 매우 우수함",
      },
      {
        id: "p2", name: "박민준", email: "mj@powernet.com", dept: "AI 연구소", status: "정상",
        tasks: [
          { id: "t3", name: "모델 배포 파이프라인", progress: 60, delta: 15 },
        ],
        summary: "CI/CD 파이프라인 구축 완료. 다음 주 프로덕션 배포 예정.",
        aiReport: "배포 파이프라인 구축이 체계적으로 진행되고 있습니다. 모니터링 지표 설계를 병행하시길 권장합니다.",
        instructorMemo: "일정 준수 우수",
      },
    ],
    chat: [{ id: uid(), role: "강사", text: "소통창입니다." }],
    schedule: { startDate: "2026-01-06", kickoffDate: "2026-02-03", endDate: "2026-06-30" },
  },
  {
    id: "c2",
    name: "대덕전자",
    participants: [
      {
        id: "p3", name: "이영희", email: "yh@daedeok.com", dept: "생산기술부", status: "정체",
        tasks: [
          { id: "t4", name: "AOI 최적화", progress: 40, delta: 0 },
          { id: "t5", name: "수요예측 고도화", progress: 20, delta: -5 },
        ],
        summary: "병목 현상으로 전처리 단계 진척이 멈춘 상태. 샘플링 전략 재검토 중.",
        aiReport: "데이터 샘플링 불균형으로 모델 성능이 정체 구간입니다. SMOTE 또는 언더샘플링 전략을 적극 검토하시기 바랍니다.",
        instructorMemo: "데이터 샘플링 재점검 요망",
      },
      {
        id: "p4", name: "최준호", email: "jh@daedeok.com", dept: "품질관리팀", status: "정상",
        tasks: [
          { id: "t6", name: "불량 예측 모델", progress: 55, delta: 8 },
        ],
        summary: "불량 패턴 분류 모델 초안 완성. 검증 단계 진입.",
        aiReport: "초기 정확도가 양호합니다. 실제 생산 환경 데이터로 검증을 진행하면 더 신뢰할 수 있는 성능 지표를 얻을 수 있습니다.",
        instructorMemo: "검증 데이터 다양성 확보 필요",
      },
    ],
    chat: [{ id: uid(), role: "강사", text: "소통창입니다." }],
    schedule: { startDate: "2026-01-13", kickoffDate: "2026-02-10", endDate: "2026-07-07" },
  },
];

/* ═══════════════════════════════════════════════════
   유틸
═══════════════════════════════════════════════════ */
const avgProgress = (p) =>
  p.tasks.length === 0 ? 0
    : Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length);

const pColor = (v) => v >= 70 ? "bg-emerald-400" : v >= 40 ? "bg-amber-400" : "bg-rose-400";

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
      <div className="bg-white rounded-2xl shadow-2xl w-96 p-6">
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
      <div className="bg-white rounded-2xl shadow-2xl w-[420px] p-6">
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

/* ─── 과제 추가 모달 ─────────────────────────────── */
function AddTaskModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const handle = () => { if (!name.trim()) return; onAdd(name.trim()); onClose(); };
  return (
    <Overlay onClose={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-96 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 bg-emerald-100 rounded-xl flex items-center justify-center text-lg">🛠️</div>
          <h3 className="text-base font-bold text-slate-800">과제 추가</h3>
        </div>
        <label className="text-xs text-slate-500 font-semibold mb-1.5 block">과제명</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handle()} placeholder="예: 데이터 전처리 파이프라인"
          className="w-full px-4 py-2.5 text-sm border border-slate-200 rounded-xl mb-5 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 transition-all" />
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
      <div className="bg-white rounded-2xl shadow-2xl w-[440px] p-6">
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
      <div className="bg-white rounded-2xl shadow-2xl w-[460px] p-6">
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

/* ─── 통합 로그인 화면 ────────────────────────────── */
function LoginScreen({ companies, onLogin, onRegister }) {
  const [tab, setTab] = useState("admin"); // "admin" | "participant"

  // 관리자 폼
  const [adminPwd, setAdminPwd] = useState("");
  const [adminErr, setAdminErr] = useState("");

  // 참여자 폼
  const [pForm, setPForm] = useState({ cid: companies[0]?.id || "", name: "", email: "", dept: "" });
  const [pErr, setPErr] = useState("");
  const [showRegister, setShowRegister] = useState(false);

  const handleAdminLogin = (e) => {
    e.preventDefault();
    if (adminPwd === "admin1234") {
      onLogin({ role: "admin" });
    } else {
      setAdminErr("비밀번호가 올바르지 않습니다.");
    }
  };

  const handleParticipantSubmit = (e) => {
    e.preventDefault();
    setPErr("");
    if (!pForm.cid || !pForm.name.trim() || !pForm.email.trim()) {
      setPErr("모든 필드를 입력해 주세요.");
      return;
    }
    const c = companies.find(co => co.id === pForm.cid);
    const existing = c?.participants.find(p => p.name === pForm.name.trim() && p.email === pForm.email.trim());

    if (existing) {
      onLogin({ role: "participant", id: existing.id });
    } else {
      if (!showRegister) {
        setShowRegister(true);
        setPErr("등록되지 않은 사용자입니다. 소속 부서를 입력하고 신규 등록해 주세요.");
      } else {
        if (!pForm.dept.trim()) {
          setPErr("신규 등록 시 부서명은 필수입니다.");
          return;
        }
        const newId = uid();
        onRegister(pForm.cid, { id: newId, name: pForm.name.trim(), email: pForm.email.trim(), dept: pForm.dept.trim() });
        // 등록 직후 로그인
        setTimeout(() => onLogin({ role: "participant", id: newId }), 50);
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
              <button type="submit"
                className="w-full py-3 mt-4 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-xl transition-colors shadow-sm">
                접속하기
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
              <div className="grid grid-cols-2 gap-4">
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
      <div className="bg-white rounded-2xl shadow-2xl w-[720px] max-h-[88vh] flex flex-col">
        {/* 헤더 */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
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
const GAS_URL = "https://script.google.com/macros/s/AKfycbyde7QfQavwgsYbfndlZglYdnXBNLkLd72KbHzFo57XHkrd4jfXwgk6CIGqyvMDrtk/exec";

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
        company.participants.forEach(p => {
          summaryText += `       - [${p.name}/${p.dept}] 진도율: ${avgProgress(p)}% (${p.status})\n`;
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
      week: targetWeek,
      reports: reports
    };

    // 2. Google Apps Script로 전송
    const response = await fetch(GAS_URL, {
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

function InstructorView({ companies, onSelectCompany, onSelectParticipant, onAddCompany, onDeleteCompany, onDeleteParticipant, onUpdateSchedule }) {
  const [showAdd, setShowAdd] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
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
      {schedTarget && (
        <ScheduleEditModal company={schedTarget}
          onSave={(sched) => { onUpdateSchedule(schedTarget.id, sched); setSchedTarget(null); }}
          onClose={() => setSchedTarget(null)} />
      )}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="총 업체 수" value={companies.length} icon="🏢" gradient="from-violet-400 to-purple-500" />
        <StatCard label="총 참여자" value={all.length} icon="👤" gradient="from-sky-400 to-blue-500" />
        <StatCard label="평균 진척도" value={`${totalAvg}%`} icon="📊" gradient="from-emerald-400 to-teal-500" />
      </div>

      {/* 업체별 프로젝트 일정 관리 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-700">📅 업체별 프로젝트 일정 관리</h2>
        </div>
        <div className="grid grid-cols-2 gap-0 divide-x divide-slate-100">
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
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">🛰️ 전사 실습 현황 모니터링</h2>
          <div className="flex items-center gap-2">
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
                      <button onClick={() => onDeleteParticipant(p.companyId, p.id)}
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
function CompanyHub({ company, isAdmin, onSelectParticipant, onAddParticipant, onAddChat, onEditChat, onDeleteChat, currentUserId }) {
  const [msg, setMsg] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editMsg, setEditMsg] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [company.chat]);

  const send = () => {
    if (!msg.trim()) return;
    onAddChat(company.id, { id: uid(), role: isAdmin ? "강사" : "참여자", senderId: currentUserId, text: msg });
    setMsg("");
  };

  const saveEdit = () => {
    if (!editMsg.trim()) return;
    onEditChat(company.id, editingId, editMsg);
    setEditingId(null);
    setEditMsg("");
  };

  return (
    <div className="space-y-5">
      {showReport && isAdmin && <ReportModal company={company} onClose={() => setShowReport(false)} />}
      {showAddParticipant && (
        <AddParticipantModal
          onAdd={(data) => onAddParticipant(company.id, data)}
          onClose={() => setShowAddParticipant(false)}
        />
      )}

      {/* 업체 헤더 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-gradient-to-br from-sky-400 to-blue-500 rounded-xl flex items-center justify-center text-white text-xl shadow-sm">🏢</div>
          <div>
            <h2 className="text-base font-bold text-slate-800">{company.name}</h2>
            <p className="text-xs text-slate-400">실습 메인 허브 · 참여자 {company.participants.length}명</p>
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

      <div className="grid grid-cols-2 gap-5">
        {/* 참여자 목록 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-700">👥 참여자 현황</h3>
            <button onClick={() => setShowAddParticipant(true)}
              className="px-3 py-1.5 bg-sky-50 text-sky-600 rounded-lg text-xs font-bold hover:bg-sky-100 transition-colors flex items-center gap-1">
              👤 참여자 등록
            </button>
          </div>
          <div className="divide-y divide-slate-50">
            {company.participants.map((p) => (
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
            {company.participants.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-slate-400">등록된 참여자가 없습니다.</p>
            )}
          </div>
        </div>

        {/* 실시간 채팅 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-700">💬 실시간 소통 광장</h3>
          </div>
          <div className="flex-1 px-5 py-4 space-y-3 overflow-y-auto min-h-[180px] max-h-[240px]">
            {company.chat.map((m, i) => {
              const isMine = m.senderId === currentUserId || (!m.senderId && m.role === (isAdmin ? "강사" : "참여자"));
              const canEdit = isAdmin || isMine;

              return (
                <div key={m.id || i} className={`flex gap-2 ${m.role === "강사" || m.role === "나" ? "flex-row-reverse" : ""}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                  ${m.role === "강사" ? "bg-violet-100 text-violet-600"
                      : m.role === "참여자" || m.role === "나" ? "bg-sky-100 text-sky-600"
                        : "bg-slate-100 text-slate-500"}`}>
                    {m.role[0]}
                  </div>
                  <div className={`max-w-[75%] flex flex-col gap-0.5 ${m.role === "강사" || m.role === "나" ? "items-end" : "items-start"}`}>
                    <span className="text-xs text-slate-400">{m.role}</span>
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
                      <div className={`group relative px-3 py-2 rounded-2xl text-sm leading-relaxed
                      ${m.role === "강사" || m.role === "나"
                          ? "bg-sky-500 text-white rounded-tr-sm"
                          : "bg-slate-100 text-slate-700 rounded-tl-sm"}`}>
                        {m.text}

                        {canEdit && (
                          <div className={`absolute top-0 flex gap-1 bg-white/90 backdrop-blur shadow-sm border border-slate-100 rounded-lg px-2 py-1.5 
                          opacity-0 group-hover:opacity-100 transition-opacity z-10
                          ${m.role === "강사" || m.role === "나" ? "right-full mr-1 -mt-1" : "left-full ml-1 -mt-1"}`}>
                            <button onClick={() => { setEditingId(m.id || i); setEditMsg(m.text); }} className="text-[11px] font-bold text-slate-500 hover:text-sky-500 whitespace-nowrap px-1">수정</button>
                            <button onClick={() => onDeleteChat(company.id, m.id)} className="text-[11px] font-bold text-slate-500 hover:text-rose-500 whitespace-nowrap px-1 border-l pl-2 ml-1">삭제</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
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

  const updateProgress = (tid, val) =>
    onUpdate({ ...participant, tasks: participant.tasks.map((t) => t.id === tid ? { ...t, progress: Number(val) } : t) });
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
        <AddTaskModal onAdd={(name) => onAddTask(participant.id, name)} onClose={() => setShowAddTask(false)} />
      )}

      {/* 헤더 카드 */}
      <div className="bg-gradient-to-r from-violet-500 via-indigo-500 to-blue-500 rounded-2xl p-5 text-white flex items-center justify-between shadow-md">
        <div>
          <div className="text-xs opacity-70 mb-0.5">{companyName} · {participant.dept}</div>
          <div className="text-2xl font-extrabold">{participant.name}</div>
          <div className="text-xs opacity-60 mt-1">{participant.email}</div>
        </div>
        <div className="text-right">
          <div className="text-5xl font-black">{actualPct}%</div>
          <div className="text-xs opacity-70">전체 진척도</div>
          {isMine ? (
            <select value={participant.status} onChange={(e) => saveStatus(e.target.value)}
              className="mt-2 px-3 py-1 bg-white/20 text-white text-xs font-semibold rounded-full border border-white/30 outline-none cursor-pointer backdrop-blur">
              <option value="정상" className="text-slate-800">🟢 정상 진행</option>
              <option value="정체" className="text-slate-800">⚠️ 실적 정체</option>
            </select>
          ) : (
            <div className="mt-2 px-3 py-1 bg-white/20 text-white text-xs font-semibold rounded-full border border-white/30 inline-block backdrop-blur">
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
          <div className="flex items-center gap-1 mb-4 text-xs">
            <span className="text-emerald-600 font-semibold">🚀 {sc.startDate}</span>
            <div className="flex-1 border-t-2 border-dashed border-slate-200 mx-2" />
            {sc.kickoffDate && <><span className="text-amber-600 font-semibold">🎯 {sc.kickoffDate}</span><div className="flex-1 border-t-2 border-dashed border-slate-200 mx-2" /></>}
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
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-slate-700 text-sm">🔗 {t.name}</span>
                  <div className="flex items-center gap-2">
                    <DeltaEl d={t.delta} />
                    <span className="text-sm font-bold text-slate-700 w-8 text-right">{t.progress}%</span>
                    {isMine && (
                      <button onClick={() => onDeleteTask(participant.id, t.id)}
                        className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-rose-400 hover:bg-rose-50 rounded-lg transition-colors"
                        title="과제 삭제">×</button>
                    )}
                  </div>
                </div>
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
  const [companies, setCompanies] = useState(INIT);
  const companiesRef = useRef(companies);
  useEffect(() => { companiesRef.current = companies; }, [companies]);

  const [isDbLoaded, setIsDbLoaded] = useState(false);
  const [authState, setAuthState] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "dashboard", "data"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data().companies;
        if (data) setCompanies(data);
      } else {
        setDoc(doc(db, "dashboard", "data"), { companies: INIT });
      }
      setIsDbLoaded(true);
    });
    return () => unsub();
  }, []);

  const updateCompanies = (updater) => {
    const next = typeof updater === "function" ? updater(companiesRef.current) : updater;
    setCompanies(next); // Optimistic UI update
    if (isDbLoaded) {
      setDoc(doc(db, "dashboard", "data"), { companies: next });
    }
  };

  // null                              = 미로그인 → 로그인 화면
  // { role: 'admin' }                = 관리자
  // { role: 'participant', id: '' }   = 참여자
  const isAdmin = authState?.role === 'admin';
  const myParticipantId = authState?.role === 'participant' ? authState.id : null;

  const [tab, setTab] = useState("company");
  const [companyId, setCompanyId] = useState(() => {
    try {
      const saved = localStorage.getItem("ai-dashboard-cid");
      return saved || INIT[0].id;
    } catch { return INIT[0].id; }
  });
  const [participantId, setParticipantId] = useState(null);

  useEffect(() => {
    localStorage.setItem("ai-dashboard-cid", companyId);
  }, [companyId]);

  const selectedCompany = companies.find((c) => c.id === companyId) || companies[0];
  const allParticipants = companies.flatMap((c) => c.participants.map((p) => ({ ...p, companyName: c.name })));
  const selectedParticipant = participantId ? allParticipants.find((p) => p.id === participantId) : null;
  const selectedParticipantCompany = participantId
    ? companies.find((c) => c.participants.some((p) => p.id === participantId))?.name || "" : "";

  const addCompany = (name) =>
    updateCompanies((prev) => [...prev, { id: uid(), name, participants: [], chat: [] }]);

  const addParticipant = (cid, { id, name, dept, email }) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : {
        ...c,
        participants: [...c.participants, {
          id: id || uid(), name, dept, email: email || "", status: "정상",
          tasks: [], summary: "", nextWeekPlan: "", instructorMemo: "",
        }],
      }
    ));

  const deleteCompany = (cid) => {
    const target = companies.find((c) => c.id === cid);
    const hadParticipant = target?.participants.some((p) => p.id === participantId);
    updateCompanies((prev) => {
      const remaining = prev.filter((c) => c.id !== cid);
      if (companyId === cid && remaining.length > 0) setCompanyId(remaining[0].id);
      return remaining;
    });
    if (hadParticipant) setParticipantId(null);
  };

  const deleteParticipant = (cid, pid) => {
    const targetComp = companies.find((c) => c.id === cid);
    if (targetComp && targetComp.participants.length === 1 && targetComp.participants[0].id === pid) {
      deleteCompany(cid);
      return;
    }
    updateCompanies((prev) =>
      prev.map((c) =>
        c.id !== cid ? c : { ...c, participants: c.participants.filter((p) => p.id !== pid) }
      )
    );
    if (participantId === pid) setParticipantId(null);
  };

  const updateParticipant = (updated) =>
    updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) => p.id === updated.id ? updated : p),
    })));

  const addTask = (pid, name) =>
    updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) =>
        p.id === pid ? { ...p, tasks: [...p.tasks, { id: uid(), name, progress: 0, delta: 0 }] } : p),
    })));

  const deleteTask = (pid, tid) =>
    updateCompanies((prev) => prev.map((c) => ({
      ...c, participants: c.participants.map((p) =>
        p.id === pid ? { ...p, tasks: p.tasks.filter((t) => t.id !== tid) } : p),
    })));

  const updateCompanySchedule = (cid, sched) =>
    updateCompanies((prev) => prev.map((c) => c.id !== cid ? c : { ...c, schedule: sched }));

  const addChat = (cid, message) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: [...c.chat, message] }
    ));

  const editChat = (cid, mid, newText) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: c.chat.map(m => m.id === mid ? { ...m, text: newText } : m) }
    ));

  const deleteChat = (cid, mid) =>
    updateCompanies((prev) => prev.map((c) =>
      c.id !== cid ? c : { ...c, chat: c.chat.filter(m => m.id !== mid) }
    ));

  const goToParticipant = (pid) => { setParticipantId(pid); setTab("personal"); };
  const goToCompany = (cid) => { setCompanyId(cid); setTab("company"); };

  // 참여자 본인 정보 파생
  const myParticipant = myParticipantId ? allParticipants.find((p) => p.id === myParticipantId) : null;
  const myCompany = myParticipantId
    ? companies.find((c) => c.participants.some((p) => p.id === myParticipantId)) : null;

  // 로그인
  const handleLogin = (auth) => {
    setAuthState(auth);
    if (auth.role === 'admin') {
      setTab("instructor");
    } else {
      const c = companies.find((co) => co.participants.some((p) => p.id === auth.id));
      setParticipantId(auth.id);
      if (c) setCompanyId(c.id);
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

  if (!isDbLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-violet-500 font-bold animate-pulse text-lg tracking-wide">
          데이터베이스 동기화 중...
        </div>
      </div>
    );
  }

  if (!authState) {
    return <LoginScreen companies={companies} onLogin={handleLogin} onRegister={addParticipant} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/30 to-sky-50/40">
      {/* 헤더 */}
      <header className="bg-white/80 backdrop-blur-md border-b border-slate-100 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
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
        <div className="max-w-6xl mx-auto px-6 flex gap-0.5">
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
                  ${companyId === c.id ? "bg-sky-500 text-white shadow-sm" : "bg-white text-slate-500 border border-slate-200 hover:border-sky-300"}
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
            onUpdateSchedule={updateCompanySchedule} />
        )}

        {tab === "company" && selectedCompany && (
          <CompanyHub key={selectedCompany.id} company={selectedCompany}
            isAdmin={isAdmin} onSelectParticipant={goToParticipant}
            onAddParticipant={addParticipant} onAddChat={addChat}
            onEditChat={editChat} onDeleteChat={deleteChat}
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
