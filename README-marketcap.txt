신고가·신저가 시가총액 및 정렬

- breakout-data.js는 Naver Stock KRX marketSum을 원 단위 marketCap으로 API에 포함합니다.
- index.html은 시가총액을 조원 단위로 표시하고 시가총액·현재가·등락률 열의 오름차순/내림차순 정렬을 처리합니다.
- kis-flow-display.js는 HTML을 그대로 전달합니다. 이전 breakout-marketcap.js 자동 주입은 중복 열을 만들기 때문에 제거했습니다.
- breakout-marketcap.js는 과거 배포와의 호환을 위해 저장소에 남아 있지만 현재 페이지에서는 불러오지 않습니다.
