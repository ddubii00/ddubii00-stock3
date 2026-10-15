const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// Remove popupModal
html = html.replace(/<div class="modal" id="popupModal">[\s\S]*?<\/div>\s*<\/div>/, '');

// Add lightweight-charts
html = html.replace('<script src="https://s3.tradingview.com/tv.js"></script>', '<script src="https://s3.tradingview.com/tv.js"></script>\n  <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>');

// Replace renderSummary
// First, remove the previously injected block if it exists
html = html.replace(/        const lwChartInstances = {};[\s\S]*?(?=    function renderSummary\(\) \{)/, '');

const oldRenderSummary = html.match(/function renderSummary\(\) \{[\s\S]*?\n    \}/)[0];
const newRenderSummary = `    const lwChartInstances = {};

    function calculateSMA(data, period) {
      const result = [];
      for (let i = 0; i < data.length; i++) {
        if (i < period - 1) continue;
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j].close;
        result.push({ time: data[i].time, value: sum / period });
      }
      return result;
    }

    function calculateEMA(data, period) {
      const result = [];
      if (data.length === 0) return result;
      const k = 2 / (period + 1);
      let ema = data[0].close;
      for (let i = 0; i < data.length; i++) {
        if (i === 0) { result.push({ time: data[i].time, value: ema }); continue; }
        ema = (data[i].close - ema) * k + ema;
        result.push({ time: data[i].time, value: ema });
      }
      return result;
    }


    async function loadLwChart(key) {
      const inst = lwChartInstances[key];
      if (!inst) return;
      try {
        const res = await fetch(\`/api/chart?key=\${encodeURIComponent(key)}&interval=\${inst.interval}\`);
        const json = await res.json();
        if (!json?.ok || !json.series) throw new Error('no data');
        let series = json.series;
        if (series.length > 700) series = series.slice(-700);

        const chartData = series.map(x => ({
          time: x.date,
          open: x.open,
          high: x.high,
          low: x.low,
          close: x.close
        }));

        inst.candleSeries.setData(chartData);
        const ema12 = calculateEMA(chartData, 12);
        const ema26 = calculateEMA(chartData, 26);
        
        const chartContainer = document.getElementById('lwchart-' + key);
        chartContainer.style.position = 'relative';
        let bgCanvas = chartContainer.querySelector('.bg-canvas');
        if (!bgCanvas) {
          bgCanvas = document.createElement('canvas');
          bgCanvas.className = 'bg-canvas';
          bgCanvas.style.position = 'absolute';
          bgCanvas.style.top = '0';
          bgCanvas.style.left = '0';
          bgCanvas.style.pointerEvents = 'none';
          chartContainer.insertBefore(bgCanvas, chartContainer.firstChild);
        }
        
        const drawBg = () => {
          if (!chartData || chartData.length === 0) return;
          const ctx = bgCanvas.getContext('2d');
          const width = chartContainer.clientWidth;
          const height = chartContainer.clientHeight;
          if (bgCanvas.width !== width || bgCanvas.height !== height) {
            bgCanvas.width = width;
            bgCanvas.height = height;
          } else {
            ctx.clearRect(0, 0, width, height);
          }
          
          const timeScale = inst.chart.timeScale();
          const logicalRange = timeScale.getVisibleLogicalRange();
          if (!logicalRange) return;
          
          const startLogical = Math.max(0, Math.floor(logicalRange.from));
          const endLogical = Math.min(chartData.length - 1, Math.ceil(logicalRange.to));
          
          for (let i = startLogical; i <= endLogical; i++) {
            let x1 = timeScale.logicalToCoordinate(i - 0.5);
            let x2 = timeScale.logicalToCoordinate(i + 0.5);
            if (x1 === null || x2 === null) continue;
            
            const macd = ema12[i].value - ema26[i].value;
            ctx.fillStyle = macd > 0 ? 'rgba(255, 0, 0, 0.08)' : 'rgba(15, 111, 255, 0.08)';
            ctx.fillRect(Math.floor(x1), 0, Math.ceil(x2 - x1), height);
          }
        };
        
        inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(inst._drawBg);
        inst.chart.timeScale().unsubscribeSizeChange(inst._drawBg);
        inst._drawBg = drawBg;
        inst.chart.timeScale().subscribeVisibleLogicalRangeChange(drawBg);
        inst.chart.timeScale().subscribeSizeChange(drawBg);
        drawBg();
  
        inst.chart.applyOptions({ layout: { backgroundColor: '#ffffff' } });

        
        [5, 10, 20, 60, 120, 200].forEach(p => {
          const smaData = calculateSMA(chartData, p);
          inst.maSeries[p].setData(smaData);
        });

        if (chartData.length > 0) {
          const to = chartData.length - 1;
          const from = Math.max(0, to - inst.visibleCount + 1);
          inst.chart.timeScale().setVisibleRange({
            from: chartData[from].time,
            to: chartData[to].time
          });
        }
      } catch (e) {
        console.error(e);
      }
    }

    function initLwChart(key, containerId) {
      const el = document.getElementById(containerId);
      const chart = LightweightCharts.createChart(el, {
        width: el.clientWidth,
        height: 270,
        layout: { backgroundColor: 'transparent', textColor: '#172033', fontFamily: 'Pretendard, sans-serif' },
        localization: { dateFormat: 'yyyy-MM-dd' },
        handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { borderColor: '#dbe3f1' },
        timeScale: { borderColor: '#dbe3f1', tickMarkFormatter: (time, tickMarkType, locale) => {
          if (tickMarkType === 0 || tickMarkType === 1) {
            if (time.year) return time.year + '.' + String(time.month).padStart(2, '0');
            if (typeof time === 'string') return time.substring(0,4) + '.' + time.substring(5,7);
            const d = new Date(time*1000); return d.getFullYear() + '.' + String(d.getMonth()+1).padStart(2,'0');
          }
          return '';
        } },
      });
      new ResizeObserver(entries => {
        if (entries.length === 0 || entries[0].target !== el) return;
        const newRect = entries[0].contentRect;
        chart.applyOptions({ width: newRect.width, height: newRect.height });
      }).observe(el);

      
      const candleSeries = chart.addCandlestickSeries({
        upColor: '#d92c2c',
        downColor: '#1f5bd8',
        borderVisible: false,
        wickUpColor: '#d92c2c',
        wickDownColor: '#1f5bd8',
        lastValueVisible: false,
        priceLineVisible: false
      });

      const maColors = { 5: '#d92c2c', 10: '#1f5bd8', 20: '#0a9d58', 60: '#e4a11b', 120: '#8040a0', 200: '#606060' };
      const maSeries = {};
      [5, 10, 20, 60, 120, 200].forEach(p => {
        maSeries[p] = chart.addLineSeries({
          color: maColors[p],
          lineWidth: 2,
          crosshairMarkerVisible: false,
          lastValueVisible: false,
          priceLineVisible: false
        });
      });

      lwChartInstances[key] = { chart, candleSeries, maSeries, interval: '1d', visibleCount: 120, toggles: { candle: true, 5: true, 10: true, 20: true, 60: true, 120: true, 200: true } };
      loadLwChart(key);
    }

    function renderSummary() {
      const root = document.getElementById('summaryCards');
      root.innerHTML = '';
      summaryItems.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'card span-6';
        div.innerHTML = \`
          <div class="head-row">
            <div>
              <div class="title">\${item.name}</div>
              <div style="display:flex;gap:12px;align-items:baseline;">
                <div class="value flat" id="v-\${item.symbol}">-</div>
                <div class="delta flat" id="d-\${item.symbol}">-</div>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
              <div style="display:flex;gap:4px;">
                <button class="btn outline tf-btn" data-key="\${item.popupKey}" data-tf="1d" style="background:var(--accent);color:#fff;">일봉</button>
                <button class="btn outline tf-btn" data-key="\${item.popupKey}" data-tf="1wk">주봉</button>
                <button class="btn outline tf-btn" data-key="\${item.popupKey}" data-tf="1mo">월봉</button>
              </div>
              <div style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--muted);">
                조회기간: <input type="number" id="period-\${item.popupKey}" value="120" style="width:50px;text-align:right;border:1px solid var(--line);border-radius:4px;padding:2px 4px;" />
              </div>
            </div>
          </div>
          <div class="legend-row" id="legend-\${item.popupKey}" style="margin-top:6px;margin-bottom:6px;font-size:13px;display:flex;gap:12px;cursor:pointer;user-select:none;">
            <span class="lg-item" data-key="\${item.popupKey}" data-series="candle" style="font-weight:bold;color:#111;">■ 캔들</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="5" style="font-weight:bold;color:#d92c2c;">■ 5</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="10" style="font-weight:bold;color:#1f5bd8;">■ 10</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="20" style="font-weight:bold;color:#0a9d58;">■ 20</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="60" style="font-weight:bold;color:#e4a11b;">■ 60</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="120" style="font-weight:bold;color:#8040a0;">■ 120</span>
            <span class="lg-item" data-key="\${item.popupKey}" data-series="200" style="font-weight:bold;color:#606060;">■ 200</span>
          </div>
          <div class="chart lw-chart" id="lwchart-\${item.popupKey}" style="height:270px;background:none;border:none;"></div>
        \`;
        root.appendChild(div);
        
        setTimeout(() => {
          initLwChart(item.popupKey, \`lwchart-\${item.popupKey}\`);
          
          // Interval buttons
          const btns = div.querySelectorAll('.tf-btn');
          btns.forEach(b => b.addEventListener('click', (e) => {
            btns.forEach(bb => { bb.style.background = '#e9f1ff'; bb.style.color = '#134db5'; });
            e.target.style.background = 'var(--accent)';
            e.target.style.color = '#fff';
            lwChartInstances[item.popupKey].interval = e.target.getAttribute('data-tf');
            loadLwChart(item.popupKey);
          }));

          // Period input
          const inp = div.querySelector(\`#period-\${item.popupKey}\`);
          inp.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val > 0) {
              lwChartInstances[item.popupKey].visibleCount = val;
              loadLwChart(item.popupKey);
            }
          });

          // Legend toggle
          const lgItems = div.querySelectorAll('.lg-item');
          lgItems.forEach(lg => lg.addEventListener('click', (e) => {
            const seriesKey = e.currentTarget.getAttribute('data-series');
            const inst = lwChartInstances[item.popupKey];
            inst.toggles[seriesKey] = !inst.toggles[seriesKey];
            
            if (seriesKey === 'candle') {
              inst.candleSeries.applyOptions({ visible: inst.toggles[seriesKey] });
            } else {
              inst.maSeries[seriesKey].applyOptions({ visible: inst.toggles[seriesKey] });
            }
            e.currentTarget.style.opacity = inst.toggles[seriesKey] ? '1' : '0.3';
          }));
        }, 0);
      });
    }`;
html = html.replace(oldRenderSummary, newRenderSummary);

// Remove popup click handlers
html = html.replace(/document\.querySelectorAll\('\\[data-popup\\]'\)\.forEach\(\(btn\) => \{[\s\S]*?\}\);\s*\n/g, '');

// Also remove popup openPopup function and close handlers later
html = html.replace(/function openPopup\(key\) \{[\s\S]*?\}\s*\n/g, '');
html = html.replace(/document\.getElementById\('closeModal'\)[\s\S]*?\}\);\s*\n/g, '');

fs.writeFileSync('index.html', html);
