/** @type {import('tailwindcss').Config} */
// 다크 테마(설정 › Display › Theme): 색 클래스(bg-slate-100, text-emerald-700 …)를 고치지 않고,
// 그 색들이 CSS 변수를 가리키게 해서 <html class="dark">일 때 변수 값만 바꾼다.
//   라이트 = Tailwind 원래 값
//   다크   = Nord 팔레트. slate는 Polar Night → Snow Storm, white는 카드 바탕, emerald(선택·경로 강조)는 Frost.
//            강조색의 연한 단계(50~300)는 카드 위에 겹친 반투명 틴트, 진한 단계는 밝은 쪽으로.
// black은 바꾸지 않는다(모달 뒤를 어둡게 하는 막 등 — 테마와 상관없이 어두워야 하는 곳에 쓴다).
const colors = require('tailwindcss/colors');
const plugin = require('tailwindcss/plugin');

const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const PALETTES = ['slate', 'emerald', 'amber', 'rose', 'cyan', 'sky', 'red', 'teal', 'indigo', 'blue', 'violet', 'orange'];

// 다크 테마 — Nord 팔레트(https://www.nordtheme.com)
//   회색 계열(slate): Polar Night 바탕(#2e3440 계열) → Snow Storm 글자(#d8dee9 계열). 숫자가 클수록 밝다(라이트와 반대)
// 보조 글자(400~600: 메타·안내·흐린 값)는 어두운 바탕에서 묻히지 않도록 Nord보다 밝게 잡았다
const DARK_SLATE = {
  50: '#353b48', 100: '#39404d', 200: '#414958', 300: '#4c566a', 400: '#8a96ad', 500: '#a0abc0',
  600: '#bcc5d4', 700: '#e0e5ee', 800: '#e9edf3', 900: '#eff2f6', 950: '#f7f8fb',
};
// 카드 바탕(white 자리) — 페이지 배경(#282d37)보다 한 단계 밝게. Nord #2e3440 계열을 살짝 어둡게
const DARK_SURFACE = '#2f3541';
// 선택·경로 강조(emerald 자리) — Frost #88c0d0 / #8fbcbb
const FROST = '#88c0d0';
const FROST_TEXT = '#8fbcbb';

const rgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
};
// a를 b 위에 t만큼 겹친 색 — 다크에서 연한 강조 바탕을 '카드 위에 깔린 반투명 틴트'처럼 보이게 한다
const blend = (a, b, t) => {
  const pa = rgb(a).split(' ').map(Number);
  const pb = rgb(b).split(' ').map(Number);
  return pa.map((v, i) => Math.round(pb[i] + (v - pb[i]) * t)).join(' ');
};
// 다크에서 강조색의 연한 단계(배경·테두리로 쓰는 50~300) = 카드 바탕 위에 겹친 정도
const TINT = { 50: 0.18, 100: 0.26, 200: 0.34, 300: 0.46 };
// 진한 단계(글자·아이콘·버튼으로 쓰는 400~950)는 밝은 쪽으로: 600 → 400, 700 → 300 …
const BRIGHT = { 400: '400', 500: '400', 600: '400', 700: '300', 800: '200', 900: '100', 950: '50' };

const varColor = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

const darkAccent = (p, s) => {
  if (p === 'emerald') {
    // 선택·경로 강조는 Frost로
    if (TINT[s] !== undefined) return blend(FROST, DARK_SURFACE, TINT[s]);
    return rgb(s === '700' || s === '800' ? FROST_TEXT : s === '900' || s === '950' ? '#d8eeee' : FROST);
  }
  if (TINT[s] !== undefined) return blend(colors[p][400], DARK_SURFACE, TINT[s]);
  return rgb(colors[p][BRIGHT[s]]);
};

const themeVars = (dark) => {
  const vars = { '--c-white': rgb(dark ? DARK_SURFACE : '#ffffff') };
  for (const p of PALETTES) {
    for (const s of SHADES) {
      vars[`--c-${p}-${s}`] = !dark ? rgb(colors[p][s]) : p === 'slate' ? rgb(DARK_SLATE[s]) : darkAccent(p, s);
    }
  }
  return vars;
};

module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        white: varColor('white'),
        ...Object.fromEntries(PALETTES.map((p) => [p, Object.fromEntries(SHADES.map((s) => [s, varColor(`${p}-${s}`)]))])),
        surface: {
          DEFAULT: '#ffffff',
          soft: '#f8fafc',
          muted: '#eef2f7'
        },
        accent: {
          DEFAULT: '#22c55e',
          soft: '#dcfce7',
          strong: '#16a34a'
        },
        status: {
          online: '#22c55e',
          offline: '#64748b',
          warning: '#f59e0b'
        }
      },
      // font-mono는 CSS 변수를 따른다 — 설정 › Display › Monospace font가 바꾼다(src/index.css에 기본값)
      fontFamily: {
        mono: ['var(--font-mono)'],
      },
      // 그림자·배경도 테마마다 다르다(index.css의 변수)
      boxShadow: {
        soft: 'var(--shadow-soft)',
        panel: 'var(--shadow-panel)',
        elevated: 'var(--shadow-elevated)',
        glow: '0 0 0 1px rgba(34, 197, 94, 0.12), 0 16px 36px rgba(34, 197, 94, 0.14)'
      },
      backgroundImage: {
        'grid-fade': 'var(--bg-grid-fade)'
      }
    }
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': themeVars(false),
        ':root.dark': themeVars(true),
      });
    }),
  ]
};
