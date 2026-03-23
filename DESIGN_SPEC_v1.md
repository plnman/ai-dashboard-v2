# [설계명세서] AI 실습 프로젝트 통합 스마트 대시보드 (v1.0)

## 📌 시스템 개요
본 시스템은 AI 실습 프로젝트의 운영을 위한 통합 모니터링 및 컨설팅 지원 플랫폼입니다. 강사와 참여자 간의 실시간 소통과 과제 진척도 관리, 그리고 AI 컨설팅 결과 공유를 목적으로 합니다.

---

## 🛠️ 기술 스택 (Tech Stack)
- **Frontend**: React (ver 19.x) + Vite
- **Styling**: TailwindCSS (Utility-first CSS)
- **Database**: Firebase Cloud Firestore (NoSQL)
- **Data Sync**: Firebase Snapshot (Real-time synchronization)
- **External Integration**: Google Apps Script (GAS) to Google Sheets
- **Icons/Media**: Lucide-React equivalent logic & Emoji-based icons

---

## 🏗️ 시스템 아키텍처

### 1. 프론트엔드 모듈 (Component Layer)
- **LoginScreen**: 관리자(비밀번호: `admin1234`) 및 참여자(이름/이메일/부서) 통합 로그인.
- **InstructorView (Admin)**: 전체 업체 수, 총 참여자 수, 평균 진척도 등 통계 대시보드 및 전체 참여자 현황 관리.
- **CompanyHub**: 특정 업체 소속 참여자들의 목록 및 업체별 실시간 채팅 광장.
- **PersonalDashboard**: 개별 참여자의 과제 리스트, 주간 요약 보고, AI 레포트 및 강사 피드백 확인.

### 2. 데이터 격리 로직 (Data Isolation)
- `company_id`를 기반으로 참여자 데이터를 필터링하여 업체 간 데이터 보안 및 독립성 유지.
- 참여자 로그인 시 자동으로 소속 업체 세션이 유지되도록 `localStorage`와 연동.

---

## 📂 데이터 스키마 (Firestore Data Model)

시스템은 단일 문서(`dashboard/data`)를 사용하여 모든 상태를 관리하며, 낙관적 UI 업데이트(Optimistic UI) 기법이 적용되어 있습니다.

### `companies` (Array)
- `id`: 유니크 식별자 (`u_...`)
- `name`: 업체명
- `participants` (Array)
    - `id`, `name`, `email`, `dept`: 기본 정보
    - `status`: 현재 상태 (`정상` | `정체`)
    - `tasks`: 과제 목록 (`{ id, name, progress, delta }`)
    - `summary`: 금주 요약 보고
    - `nextWeekPlan`: 차주 계획
    - `aiReport`: AI 컨설팅 결과물
    - `instructorMemo`: 강사 전용 피드백
- `chat` (Array): 메시지 객체 리스트 (`{ id, role, text, replies, createdAt }`)
- `schedule`: 프로젝트 일정 (`startDate`, `kickoffDate`, `endDate`)

---

## 🛰️ 외부 통합 기능 (Google Sheets Export)

### Google Apps Script 연동
- **엔드포인트**: `GAS_URL` (POST 방식)
- **주요 액션**:
    1. `publishReport`: 주차별 참여자 요약 보고서를 구글 스프레드시트로 일괄 전송.
    2. `updateParticipants`: 최신 참여자 명단을 구글 스프레드시트 '참여자' 시트로 업데이트.

---

## 🎨 UI/UX 설계 원칙
- **Theme**: Bright & Professional (White/Blue Accent 기반)
- **Interactivity**: 
    - 애니메이션 효과 (Scale, Fade, Slide-in) 적용.
    - 반응형 레이아웃 (모바일 및 태스크탑 대응).
    - 로딩 스피너 및 데이터 동기화 상태 표시 ("데이터베이스 동기화 중...").

---

## 📅 향후 계획 (Next Steps)
- 모바일 UI 최적화 강화.
- AI 레포트 자동 생성 엔진 연동.
- 과거 주차별 데이터 히스토리 아카이빙 기능 추가.

---
**최종 업데이트:** 2026-03-23
**버전:** v1.0.0 (Release Candidate)
