import { useState } from "react";

// ─── 샘플 데이터 ───────────────────────────────────────────────
const initialCompanies = [
  {
    id: 1,
    name: "삼성전자",
    participants: [
      {
        id: 1,
        name: "김철수",
        email: "ks@samsung.com",
        dept: "DX 추진팀",
        status: "정상",
        tasks: [
          { id: 1, name: "딥러닝 경량화", progress: 80, delta: 10, github: "#", doc: "#" },
          { id: 2, name: "비전 검사 자동화", progress: 75, delta: 5, github: "#", doc: "#" },
          { id: 3, name: "데이터 전처리", progress: 30, delta: 0, github: "#", doc: "#" },
        ],
        summary: "이번 주에는 양자화 기법을 적용하여 정확도 손실을 2% 이내로 방어하며 추론 속도를 개선했습니다. 다음 주차에는 엣지 디바이스 환경에서의 최적화 테스트를 진행할 예정입니다.",
        aiReport: "본 과제의 핵심인 양자화 단계에서 주목할 만한 진척이 관찰되었습니다. 강사의 검토 결과, 현재 적용 중인 기법은 모델 성능 유지와 속도 향상 사이의 균형을 잘 잡고 있습니다. 다음 주차에는 엣지 디바이스로의 이식 과정에서 발생할 수 있는 메모리 누수 현상을 중점적으로 모니터링하시길 권장합니다.",
        instructorMemo: "기법 적용이 매우 우수함",
      },
      {
        id: 2,
        name: "박민준",
        email: "mj@samsung.com",
        dept: "AI 연구소",
        status: "정상",
        tasks: [
          { id: 1, name: "모델 배포 파이프라인", progress: 60, delta: 15, github: "#", doc: "#" },
        ],
        summary: "CI/CD 파이프라인 구축 완료. 다음 주 프로덕션 배포 예정.",
        aiReport: "배포 파이프라인 구축이 체계적으로 진행되고 있습니다. 모니터링 지표 설계를 병행하시길 권장합니다.",
        instructorMemo: "일정 준수 우수",
      },
    ],
    chat: [
      { role: "강사", text: "삼성전자 팀 여러분, 이번 주 과제 진척도를 오늘 중으로 업데이트 부탁드립니다." },
      { role: "이영희", text: "네, 데이터 전처리 단계에서 발생한 이슈 해결 후 바로 업데이트하겠습니다." },
    ],
  },
  {
    id: 2,
    name: "대덕전자",
    participants: [
      {
        id: 3,
        name: "이영희",
        email: "yh@daedeok.com",
        dept: "생산기술부",
        status: "정체",
        tasks: [
          { id: 1, name: "AOI 최적화", progress: 40, delta: 0, github: "#", doc: "#" },
          { id: 2, name: "수요예측 고도화", progress: 20, delta: -5, github: "#", doc: "#" },
        ],
        summary: "병목 현상이 발생하여 전처리 단계에서 진척이 멈춘 상태입니다. 샘플링 전략 재검토 중입니다.",
        aiReport: "데이터 샘플링 불균형으로 인해 모델 성능이 정체 구간에 진입했습니다. SMOTE 또는 언더샘플링 전략을 적극 검토하시기 바랍니다. 다음 주 중간 점검 미팅을 권장합니다.",
        instructorMemo: "데이터 샘플링 재점검 요망",
      },
    ],
    chat: [
      { role: "강사", text: "대덕전자 팀, AOI 과제 병목 현상 관련 내일 미팅 잡겠습니다." },
    ],
  },
];

// ─── 유틸 ──────────────────────────────────────────────────────
function progressColor(p) {
  if (p >= 70) return "bg-emerald-400";
  if (p >= 40) return "bg-amber-400";
  return "bg-rose-400";
}
function statusBadge(s) {
  if (s === "정상") return "bg-emerald-100 text-emerald-700 border border-emerald-300";
  if (s === "정체") return "bg-amber-100 text-amber-700 border border-amber-300";
  return "bg-slate-100 text-slate-500";
}
function deltaText(d) {
  if (d > 0) return <span className="text-emerald-600 font-semibold">+{d}%↑</span>;
  if (d < 0) return <span className="text-rose-500 font-semibold">{d}%↓</span>;
  return <span className="text-slate-400">0%</span>;
}
function avgProgress(participant) {
  const t = participant.tasks;
  return Math.round(t.reduce((s, x) => s + x.progress, 0) / t.length);
}

// ─── 진척도 바 ─────────────────────────────────────────────────
function ProgressBar({ value }) {
  return (
    <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
      <div
        className={`h-2.5 rounded-full transition-all duration-700 ${progressColor(value)}`}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

// ─── 탭 1: 강사 관제 센터 ────────────────────────────────────────
function InstructorView({ companies, onSelectCompany, onSelectParticipant }) {
  const allParticipants = companies.flatMap((c) =>
    c.participants.map((p) => ({ ...p, companyName: c.name, companyId: c.id }))
  );

  return (
    <div className="space-y-6">
      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="총 업체 수" value={companies.length} icon="🏢" color="from-violet-400 to-purple-500" />
        <StatCard label="총 참여자" value={allParticipants.length} icon="👤" color="from-sky-400 to-blue-500" />
        <StatCard
          label="평균 진척도"
          value={`${Math.round(allParticipants.reduce((s, p) => s + avgProgress(p), 0) / allParticipants.length)}%`}
          icon="📊"
          color="from-emerald-400 to-teal-500"
        />
      </div>

      {/* 전사 현황 테이블 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-700 flex items-center gap-2">
            🛰️ 전사 실습 현황 모니터링
          </h2>
          <span className="text-xs text-slate-400">최종 업데이트: 2026-02-25 16:30</span>
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
                <th className="px-5 py-3 text-center">상세</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {allParticipants.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3.5 font-semibold text-slate-700">{p.companyName}</td>
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-slate-700">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.email}</div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-600">{p.tasks[0]?.name}</td>
                  <td className="px-5 py-3.5 w-36">
                    <div className="flex items-center gap-2">
                      <ProgressBar value={avgProgress(p)} />
                      <span className="text-xs font-semibold text-slate-600 w-8">{avgProgress(p)}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusBadge(p.status)}`}>
                      {p.status === "정상" ? "🟢 정상" : "⚠️ 정체"}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 text-xs max-w-[160px] truncate">
                    {p.instructorMemo}
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <button
                      onClick={() => { onSelectCompany(p.companyId); onSelectParticipant(p.id); }}
                      className="px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg text-xs font-semibold hover:bg-violet-100 transition-colors"
                    >
                      상세보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color }) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-2xl p-5 text-white shadow-sm`}>
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm opacity-80 mt-1">{label}</div>
    </div>
  );
}

// ─── 탭 2: 업체 허브 ─────────────────────────────────────────────
function CompanyHub({ company, onSelectParticipant }) {
  const [chatMsg, setChatMsg] = useState("");
  const [messages, setMessages] = useState(company.chat);

  const sendMsg = () => {
    if (!chatMsg.trim()) return;
    setMessages([...messages, { role: "나", text: chatMsg }]);
    setChatMsg("");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-br from-sky-400 to-blue-500 rounded-xl flex items-center justify-center text-white text-lg">🏢</div>
        <div>
          <h2 className="text-lg font-bold text-slate-800">{company.name}</h2>
          <p className="text-xs text-slate-400">실습 메인 허브</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* 참여자 목록 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-700">📝 참여자 현황</h3>
          </div>
          <div className="divide-y divide-slate-50">
            {company.participants.map((p) => (
              <div key={p.id} className="px-5 py-4 hover:bg-slate-50 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-semibold text-slate-700">{p.name}</span>
                    <span className="ml-2 text-xs text-slate-400">{p.dept}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge(p.status)}`}>
                    {p.status === "정상" ? "🟢" : "⚠️"} {p.status}
                  </span>
                </div>
                <ProgressBar value={avgProgress(p)} />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-slate-400">{p.tasks.length}개 과제 · {avgProgress(p)}% 완료</span>
                  <button
                    onClick={() => onSelectParticipant(p.id)}
                    className="text-xs text-violet-600 font-semibold hover:underline"
                  >
                    상세보기 →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 실시간 채팅 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-700">💬 실시간 소통 광장</h3>
          </div>
          <div className="flex-1 px-5 py-4 space-y-3 overflow-y-auto min-h-[180px] max-h-[220px]">
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-2 ${m.role === "나" ? "flex-row-reverse" : ""}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${m.role === "강사" ? "bg-violet-100 text-violet-600" : m.role === "나" ? "bg-sky-100 text-sky-600" : "bg-slate-100 text-slate-500"}`}>
                  {m.role[0]}
                </div>
                <div className={`max-w-[75%] ${m.role === "나" ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
                  <span className="text-xs text-slate-400">{m.role}</span>
                  <div className={`px-3 py-2 rounded-2xl text-sm ${m.role === "나" ? "bg-sky-500 text-white rounded-tr-sm" : "bg-slate-100 text-slate-700 rounded-tl-sm"}`}>
                    {m.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-slate-100 flex gap-2">
            <input
              value={chatMsg}
              onChange={(e) => setChatMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMsg()}
              placeholder="메시지 입력..."
              className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 transition-all"
            />
            <button
              onClick={sendMsg}
              className="px-4 py-2 bg-violet-500 text-white rounded-xl text-sm font-semibold hover:bg-violet-600 transition-colors"
            >
              전송
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 탭 3: 개인 대시보드 ──────────────────────────────────────────
function PersonalDashboard({ participant, companyName }) {
  const [showReport, setShowReport] = useState(false);
  const [memo, setMemo] = useState(participant.instructorMemo);

  return (
    <div className="space-y-5">
      {/* 헤더 */}
      <div className="bg-gradient-to-r from-violet-500 to-indigo-500 rounded-2xl p-5 text-white flex items-center justify-between">
        <div>
          <div className="text-sm opacity-80 mb-1">{companyName} · {participant.dept}</div>
          <div className="text-2xl font-bold">{participant.name}</div>
          <div className="text-sm opacity-70 mt-1">{participant.email}</div>
        </div>
        <div className="text-right">
          <div className="text-4xl font-extrabold">{avgProgress(participant)}%</div>
          <div className="text-sm opacity-80">전체 진척도</div>
          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-xs font-bold bg-white/20 backdrop-blur-sm`}>
            {participant.status === "정상" ? "🟢 정상 진행" : "⚠️ 실적 정체"}
          </span>
        </div>
      </div>

      {/* 과제 목록 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">🛠️ 내 과제 현황</h3>
          <span className="text-xs text-slate-400">{participant.tasks.length}개 과제</span>
        </div>
        <div className="divide-y divide-slate-50">
          {participant.tasks.map((t) => (
            <div key={t.id} className="px-5 py-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-700 text-sm">🔗 {t.name}</span>
                <div className="flex items-center gap-3 text-xs">
                  {deltaText(t.delta)}
                  <span className="font-bold text-slate-700">{t.progress}%</span>
                </div>
              </div>
              <ProgressBar value={t.progress} />
              <div className="flex gap-3 mt-2">
                <a href={t.github} className="text-xs text-sky-500 hover:underline">📂 GitHub</a>
                <a href={t.doc} className="text-xs text-sky-500 hover:underline">📂 설계서</a>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 금주 요약 보고 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-700">📝 금주 요약 보고</h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-4">
            "{participant.summary}"
          </p>
        </div>
      </div>

      {/* 강사 메모 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-700">✏️ 강사 피드백 메모</h3>
        </div>
        <div className="px-5 py-4 flex gap-3">
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-50 transition-all"
          />
          <button className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-semibold hover:bg-emerald-600 transition-colors">
            저장
          </button>
        </div>
      </div>

      {/* AI 레포트 */}
      <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-2xl border border-violet-100 overflow-hidden">
        <button
          onClick={() => setShowReport(!showReport)}
          className="w-full px-5 py-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span className="text-lg">🤖</span>
            <span className="text-sm font-bold text-violet-700">AI 주간 컨설팅 레포트</span>
            <span className="text-xs bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full">강사 승인 완료</span>
          </div>
          <span className="text-violet-400 text-lg">{showReport ? "▲" : "▼"}</span>
        </button>
        {showReport && (
          <div className="px-5 pb-5">
            <div className="bg-white rounded-xl p-4 text-sm text-slate-600 leading-relaxed border border-violet-100">
              {participant.aiReport}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 메인 앱 ──────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState("instructor");
  const [selectedCompanyId, setSelectedCompanyId] = useState(initialCompanies[0].id);
  const [selectedParticipantId, setSelectedParticipantId] = useState(null);

  const selectedCompany = initialCompanies.find((c) => c.id === selectedCompanyId) || initialCompanies[0];
  const selectedParticipant =
    selectedParticipantId !== null
      ? initialCompanies.flatMap((c) => c.participants).find((p) => p.id === selectedParticipantId)
      : null;

  const handleSelectCompany = (id) => {
    setSelectedCompanyId(id);
    setActiveTab("company");
  };
  const handleSelectParticipant = (id) => {
    setSelectedParticipantId(id);
    setActiveTab("personal");
  };

  const tabs = [
    { id: "instructor", label: "🎖️ 강사 관제 센터" },
    { id: "company", label: "🏢 업체 허브" },
    { id: "personal", label: "👤 개인 대시보드" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/30 to-sky-50/40 font-sans">
      {/* 헤더 */}
      <header className="bg-white/80 backdrop-blur-md border-b border-slate-100 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-violet-500 to-indigo-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">AI</div>
            <div>
              <h1 className="text-base font-extrabold text-slate-800 leading-tight">AI 실습 프로젝트</h1>
              <p className="text-xs text-slate-400">통합 스마트 대시보드</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs bg-emerald-50 text-emerald-600 border border-emerald-200 px-2.5 py-1 rounded-full font-medium">🔑 관리자 모드</span>
            <span className="text-xs text-slate-400">2026-02-25</span>
          </div>
        </div>

        {/* 탭 네비게이션 */}
        <div className="max-w-6xl mx-auto px-6 flex gap-1 pb-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2.5 text-sm font-semibold rounded-t-xl transition-all border-b-2 ${
                activeTab === t.id
                  ? "text-violet-600 border-violet-500 bg-violet-50"
                  : "text-slate-400 border-transparent hover:text-slate-600 hover:border-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* 메인 콘텐츠 */}
      <main className="max-w-6xl mx-auto px-6 py-6">
        {/* 업체 허브 — 업체 선택 셀렉터 */}
        {activeTab === "company" && (
          <div className="flex gap-2 mb-5">
            {initialCompanies.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCompanyId(c.id)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${
                  selectedCompanyId === c.id
                    ? "bg-sky-500 text-white"
                    : "bg-white text-slate-500 border border-slate-200 hover:border-sky-300"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {/* 개인 대시보드 — 참여자 선택 셀렉터 */}
        {activeTab === "personal" && (
          <div className="flex gap-2 mb-5 flex-wrap">
            {initialCompanies.flatMap((c) =>
              c.participants.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedParticipantId(p.id)}
                  className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${
                    selectedParticipantId === p.id
                      ? "bg-violet-500 text-white"
                      : "bg-white text-slate-500 border border-slate-200 hover:border-violet-300"
                  }`}
                >
                  {p.name} <span className="opacity-60 text-xs">({c.name})</span>
                </button>
              ))
            )}
          </div>
        )}

        {activeTab === "instructor" && (
          <InstructorView
            companies={initialCompanies}
            onSelectCompany={handleSelectCompany}
            onSelectParticipant={handleSelectParticipant}
          />
        )}
        {activeTab === "company" && (
          <CompanyHub
            company={selectedCompany}
            onSelectParticipant={handleSelectParticipant}
          />
        )}
        {activeTab === "personal" && selectedParticipant && (
          <PersonalDashboard
            participant={selectedParticipant}
            companyName={
              initialCompanies.find((c) =>
                c.participants.some((p) => p.id === selectedParticipant.id)
              )?.name || ""
            }
          />
        )}
        {activeTab === "personal" && !selectedParticipant && (
          <div className="text-center py-20 text-slate-400">
            <div className="text-4xl mb-3">👆</div>
            <p className="text-sm font-medium">위에서 참여자를 선택해 주세요</p>
          </div>
        )}
      </main>
    </div>
  );
}
