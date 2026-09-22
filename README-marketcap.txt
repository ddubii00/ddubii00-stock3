stock3-7 신고가/신저가 시가총액(조) 표시 업데이트

GitHub master 기준 수정 파일
1. breakout-data.js
   - Naver Stock KRX marketSum 값을 marketCap으로 신고가/신저가 API 응답에 포함

2. kis-flow-display.js
   - 기존 대형 index.html을 직접 수정하지 않고 HTML 응답에 breakout-marketcap.js를 1회 주입

3. breakout-marketcap.js (신규)
   - 신고가/신저가 표에서 '종목' 다음에 '시가총액(조)' 열 추가
   - marketCap / 1e12 로 조원 환산, 소수 둘째 자리까지 표시
   - 새로고침/테이블 재렌더링에도 자동 복원
   - 기존 10열 로딩 행 colspan을 11로 자동 보정

표시 예
삼성전자 | 521.34
중소형주   | 0.86

GitHub 업로드
- breakout-data.js -> 저장소 루트의 기존 파일 덮어쓰기
- kis-flow-display.js -> 저장소 루트의 기존 파일 덮어쓰기
- breakout-marketcap.js -> 저장소 루트에 새 파일 추가

index.html은 수정하지 않습니다.
